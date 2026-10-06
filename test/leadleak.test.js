const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  normalizeEmail,
  generateLeadFingerprint,
  LeadIngestionEngine,
  DeduplicationEngine,
  SlaAuditor,
  FunnelSimulator,
  RecoveryDispatcher
} = require('../src/index.js');

test('LeadLeak Detector: normalizePhone formats numbers canonically', () => {
  assert.equal(normalizePhone('(512) 555-0199'), '+15125550199');
  assert.equal(normalizePhone('+1-512-555-0199'), '+15125550199');
  assert.equal(normalizePhone('447911123456'), '+447911123456');
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone(null), '');
});

test('LeadLeak Detector: normalizeEmail cleans domains and aliases', () => {
  assert.equal(normalizeEmail('John.Doe+promo@gmail.com'), 'johndoe@gmail.com');
  assert.equal(normalizeEmail('SARAH@COMPANY.COM  '), 'sarah@company.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
});

test('LeadLeak Detector: generateLeadFingerprint resolves identity across channels', () => {
  const fp1 = generateLeadFingerprint({ email: 'alex@startup.io', phone: '5125550100', name: 'Alex Vance' });
  const fp2 = generateLeadFingerprint({ email: 'ALEX@STARTUP.IO', phone: '(512) 555-0100', name: 'Alex' });
  assert.equal(fp1, fp2);
});

test('LeadLeak Detector: Ingestion and Deduplication Engine merges cross-channel leads', () => {
  const engine = new LeadIngestionEngine();
  const l1 = engine.ingest({
    name: 'Marcus Brody',
    email: 'marcus@brody.com',
    channel: 'web_form',
    dealValue: 3500
  });

  const l2 = engine.ingest({
    name: 'Marcus Brody',
    email: 'marcus@brody.com',
    channel: 'whatsapp',
    dealValue: 5000 // higher quote via WhatsApp
  });

  assert.equal(engine.getAll().length, 2);

  const dedupeResult = DeduplicationEngine.deduplicate(engine.getAll());
  assert.equal(dedupeResult.duplicatesRemoved, 1);
  assert.equal(dedupeResult.uniqueLeads.length, 1);
  assert.equal(dedupeResult.uniqueLeads[0].dealValue, 5000); // Retained highest value
  assert.deepEqual(dedupeResult.uniqueLeads[0].crossChannels.sort(), ['web_form', 'whatsapp'].sort());
});

test('LeadLeak Detector: SLA Auditor categorizes response latencies accurately', () => {
  const auditor = new SlaAuditor({ defaultCloseRate: 0.3 });
  const now = new Date('2026-10-04T12:00:00Z');

  // Elite: 3 mins
  const eliteLead = {
    id: 'l1',
    name: 'Elite Buyer',
    dealValue: 4000,
    channel: 'web_form',
    receivedAt: '2026-10-04T11:50:00Z',
    firstContactAt: '2026-10-04T11:53:00Z'
  };
  const eliteAudit = auditor.auditLead(eliteLead, now);
  assert.equal(eliteAudit.slaStatus, 'HEALTHY');
  assert.equal(eliteAudit.isLeaked, false);
  assert.equal(eliteAudit.responseMinutes, 3);

  // High Risk: 45 mins
  const slowLead = {
    id: 'l2',
    name: 'Slow Buyer',
    dealValue: 2500,
    channel: 'email',
    receivedAt: '2026-10-04T11:00:00Z',
    firstContactAt: '2026-10-04T11:45:00Z'
  };
  const slowAudit = auditor.auditLead(slowLead, now);
  assert.equal(slowAudit.slaStatus, 'DEGRADED');
  assert.equal(slowAudit.responseMinutes, 45);

  // Leaked: Uncontacted for 3 hours
  const leakedLead = {
    id: 'l3',
    name: 'Abandoned Buyer',
    dealValue: 8000,
    channel: 'whatsapp',
    receivedAt: '2026-10-04T08:00:00Z',
    firstContactAt: null
  };
  const leakedAudit = auditor.auditLead(leakedLead, now);
  assert.equal(leakedAudit.slaStatus, 'BREACHED');
  assert.equal(leakedAudit.isLeaked, true);
  assert.equal(leakedAudit.riskAmount, 8000);
});

test('LeadLeak Detector: auditBatch computes median response time and pipeline at risk', () => {
  const auditor = new SlaAuditor({ defaultCloseRate: 0.25 });
  const now = new Date('2026-10-04T15:00:00Z');

  const leads = [
    // Contacted in 10m
    { id: '1', name: 'Lead 1', dealValue: 2000, receivedAt: '2026-10-04T14:00:00Z', firstContactAt: '2026-10-04T14:10:00Z' },
    // Contacted in 20m
    { id: '2', name: 'Lead 2', dealValue: 3000, receivedAt: '2026-10-04T14:00:00Z', firstContactAt: '2026-10-04T14:20:00Z' },
    // Contacted in 60m
    { id: '3', name: 'Lead 3', dealValue: 5000, receivedAt: '2026-10-04T13:00:00Z', firstContactAt: '2026-10-04T14:00:00Z' },
    // Uncontacted for 5 hours (Leaked!)
    { id: '4', name: 'Lead 4', dealValue: 10000, receivedAt: '2026-10-04T10:00:00Z', firstContactAt: null }
  ];

  const batchAudit = auditor.auditBatch(leads, now);

  assert.equal(batchAudit.totalLeads, 4);
  assert.equal(batchAudit.contactedCount, 3);
  assert.equal(batchAudit.leakedCount, 1);
  assert.equal(batchAudit.medianResponseMinutes, 20); // Median of 10, 20, 60 is 20
  assert.equal(batchAudit.pipelineAtRisk, 10000);
  assert.equal(batchAudit.estimatedRealLoss, 2500); // 25% of 10,000
});

test('LeadLeak Detector: FunnelSimulator calculates lost revenue against counterfactual', () => {
  const sim = FunnelSimulator.simulateFunnel({
    totalLeads: 100,
    contactRate: 0.72,
    qualifyRate: 0.57,
    proposalRate: 0.46,
    closeRate: 0.37,
    avgDealSize: 1500
  });

  assert.equal(sim.funnel[0].count, 100);
  assert.equal(sim.funnel[1].count, 72); // 72 contacted
  assert.equal(sim.leakedBeforeContact, 28); // 28 lost before first contact
  assert.equal(sim.leakPercentage, 28);
  assert.ok(sim.lostRevenueToLeadLeak > 0, 'Lost revenue must be strictly positive');
});

test('LeadLeak Detector: RecoveryDispatcher creates actionable rescue dispatches', () => {
  const leakedLeads = [
    { id: 'lead_01', name: 'Sarah Connor', channel: 'whatsapp', dealValue: 4500 },
    { id: 'lead_02', name: 'James Logan', channel: 'phone_call', dealValue: 6000 },
    { id: 'lead_03', name: 'Elena Fisher', channel: 'web_form', dealValue: 3000 }
  ];

  const dispatch = RecoveryDispatcher.dispatchRecovery(leakedLeads);

  assert.equal(dispatch.recoveredCount, 3);
  assert.equal(dispatch.recoveredValue, 13500);
  assert.equal(dispatch.records.length, 3);
  assert.ok(dispatch.records[0].actionHook.includes('WhatsApp'));
  assert.ok(dispatch.records[1].actionHook.includes('Instant SMS'));
  assert.ok(dispatch.records[2].actionHook.includes('personally reviewed your request'));
});
