const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LeadIngestionEngine,
  DeduplicationEngine,
  SlaAuditor,
  normalizePhone,
  normalizeEmail
} = require('../src/index.js');

test('LeadLeak Edge Cases: handles completely empty and null inputs safely', () => {
  const engine = new LeadIngestionEngine();
  const lead = engine.ingest({ name: '', email: null, phone: undefined });
  assert.equal(lead.name, 'Anonymous Prospect');
  assert.equal(lead.email, '');
  assert.equal(lead.phone, '');
  assert.ok(lead.id.startsWith('lead_'));
});

test('LeadLeak Edge Cases: deduplicates multiple rapid submissions within same second', () => {
  const engine = new LeadIngestionEngine();
  const raw = { name: 'Rapid Clicker', email: 'rapid@test.com', phone: '5125550100', dealValue: 1200 };
  engine.ingest(raw);
  engine.ingest(raw);
  engine.ingest(raw);

  const dedupe = DeduplicationEngine.deduplicate(engine.getAll());
  assert.equal(dedupe.uniqueLeads.length, 1);
  assert.equal(dedupe.duplicatesRemoved, 2);
});

test('LeadLeak Edge Cases: auditor handles future or negative timestamp gracefully', () => {
  const auditor = new SlaAuditor();
  const now = new Date('2026-10-05T12:00:00Z');
  const futureLead = {
    id: 'future_1',
    name: 'Future Lead',
    dealValue: 2000,
    receivedAt: '2026-10-05T13:00:00Z', // 1 hour in future due to clock skew
    firstContactAt: '2026-10-05T13:02:00Z'
  };

  const audit = auditor.auditLead(futureLead, now);
  assert.ok(audit.responseMinutes >= 0, 'Latency must not be negative');
});
