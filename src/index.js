/**
 * @gideon/leadleak-detector
 * Project #01 in the Master 50 Business Problem & Revenue Leak Weapons
 * 
 * Commercial Mission:
 * Stops companies from losing 20-40% of their inbound leads by enforcing
 * multi-channel ingestion, deduplication, strict response SLAs, and 1-click recovery.
 */

const crypto = require('crypto');

/**
 * Normalizes phone numbers to standard E.164-like clean format.
 */
function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return '';
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

/**
 * Normalizes email address for canonical comparison.
 */
function normalizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') return '';
  const trimmed = rawEmail.trim().toLowerCase();
  const parts = trimmed.split('@');
  if (parts.length !== 2) return trimmed;
  let [local, domain] = parts;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/**
 * Generates deterministic fingerprint for cross-channel identity resolution.
 */
function generateLeadFingerprint(lead) {
  const normEmail = normalizeEmail(lead.email || '');
  const normPhone = normalizePhone(lead.phone || '');
  const normName = (lead.name || '').trim().toLowerCase();

  const key = normEmail || normPhone || normName;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * SLA Response Tiers
 */
const SLA_TIERS = {
  ELITE: { maxMinutes: 5, label: 'Elite (Under 5m)', status: 'HEALTHY', color: 'green' },
  ACCEPTABLE: { maxMinutes: 30, label: 'Acceptable (5-30m)', status: 'WARNING', color: 'yellow' },
  HIGH_RISK: { maxMinutes: 120, label: 'High Risk (30m-2h)', status: 'DEGRADED', color: 'orange' },
  CRITICAL_LEAK: { maxMinutes: Infinity, label: 'Critical Leak (>2h / Uncontacted)', status: 'BREACHED', color: 'red' }
};

class LeadIngestionEngine {
  constructor() {
    this.leads = new Map();
  }

  ingest(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid lead payload: expected object');
    }

    const id = raw.id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const receivedAt = raw.receivedAt ? new Date(raw.receivedAt) : new Date();
    const channel = (raw.channel || 'web_form').toLowerCase();
    const dealValue = Number(raw.dealValue) > 0 ? Number(raw.dealValue) : 1500;

    const leadRecord = {
      id,
      name: (raw.name || 'Anonymous Prospect').trim(),
      email: normalizeEmail(raw.email || ''),
      phone: normalizePhone(raw.phone || ''),
      channel,
      dealValue,
      receivedAt: receivedAt.toISOString(),
      firstContactAt: raw.firstContactAt ? new Date(raw.firstContactAt).toISOString() : null,
      owner: raw.owner || null,
      status: raw.status || (raw.firstContactAt ? 'CONTACTED' : 'UNCONTACTED'),
      notes: raw.notes || '',
      fingerprint: generateLeadFingerprint(raw),
      metadata: raw.metadata || {}
    };

    this.leads.set(id, leadRecord);
    return leadRecord;
  }

  ingestBatch(batch) {
    if (!Array.isArray(batch)) throw new Error('Expected array of leads');
    return batch.map(lead => this.ingest(lead));
  }

  getAll() {
    return Array.from(this.leads.values());
  }

  clear() {
    this.leads.clear();
  }
}

class DeduplicationEngine {
  static deduplicate(leads) {
    const fingerprintMap = new Map();
    const duplicates = [];

    for (const lead of leads) {
      const fp = lead.fingerprint;
      if (fingerprintMap.has(fp)) {
        const existing = fingerprintMap.get(fp);
        // Merge channel and metadata
        existing.crossChannels = existing.crossChannels || [existing.channel];
        if (!existing.crossChannels.includes(lead.channel)) {
          existing.crossChannels.push(lead.channel);
        }
        // Retain highest deal value
        if (lead.dealValue > existing.dealValue) {
          existing.dealValue = lead.dealValue;
        }
        duplicates.push({ originalId: existing.id, duplicateId: lead.id, lead });
      } else {
        fingerprintMap.set(fp, { ...lead, crossChannels: [lead.channel] });
      }
    }

    return {
      uniqueLeads: Array.from(fingerprintMap.values()),
      duplicatesRemoved: duplicates.length,
      duplicateDetails: duplicates
    };
  }
}

class SlaAuditor {
  constructor(options = {}) {
    this.defaultCloseRate = options.defaultCloseRate || 0.25; // 25% average win rate on contacted leads
  }

  auditLead(lead, asOfTime = new Date()) {
    const received = new Date(lead.receivedAt).getTime();
    const firstContact = lead.firstContactAt ? new Date(lead.firstContactAt).getTime() : null;
    const now = new Date(asOfTime).getTime();

    let responseMinutes = 0;
    let isContacted = Boolean(firstContact);

    if (isContacted) {
      responseMinutes = Math.max(0, (firstContact - received) / (1000 * 60));
    } else {
      responseMinutes = Math.max(0, (now - received) / (1000 * 60));
    }

    let tier = SLA_TIERS.CRITICAL_LEAK;
    if (isContacted) {
      if (responseMinutes <= SLA_TIERS.ELITE.maxMinutes) tier = SLA_TIERS.ELITE;
      else if (responseMinutes <= SLA_TIERS.ACCEPTABLE.maxMinutes) tier = SLA_TIERS.ACCEPTABLE;
      else if (responseMinutes <= SLA_TIERS.HIGH_RISK.maxMinutes) tier = SLA_TIERS.HIGH_RISK;
      else tier = SLA_TIERS.CRITICAL_LEAK;
    } else {
      if (responseMinutes <= 15) tier = SLA_TIERS.ACCEPTABLE;
      else if (responseMinutes <= 60) tier = SLA_TIERS.HIGH_RISK;
      else tier = SLA_TIERS.CRITICAL_LEAK;
    }

    const isLeaked = !isContacted && responseMinutes > 30; // Uncontacted for >30m is leaking

    return {
      leadId: lead.id,
      name: lead.name,
      channel: lead.channel,
      dealValue: lead.dealValue,
      isContacted,
      responseMinutes: Math.round(responseMinutes * 10) / 10,
      slaStatus: tier.status,
      slaTier: tier.label,
      color: tier.color,
      isLeaked,
      riskAmount: isLeaked ? lead.dealValue : 0
    };
  }

  auditBatch(leads, asOfTime = new Date()) {
    const results = leads.map(l => this.auditLead(l, asOfTime));

    const contacted = results.filter(r => r.isContacted);
    const uncontacted = results.filter(r => !r.isContacted);
    const leaked = results.filter(r => r.isLeaked);

    // Calculate median response time for contacted leads
    let medianResponseMinutes = 0;
    if (contacted.length > 0) {
      const sortedTimes = contacted.map(r => r.responseMinutes).sort((a, b) => a - b);
      const mid = Math.floor(sortedTimes.length / 2);
      medianResponseMinutes = sortedTimes.length % 2 !== 0 
        ? sortedTimes[mid] 
        : (sortedTimes[mid - 1] + sortedTimes[mid]) / 2;
    }

    const totalPipelineValue = leads.reduce((sum, l) => sum + (l.dealValue || 0), 0);
    const pipelineAtRisk = leaked.reduce((sum, l) => sum + (l.riskAmount || 0), 0);
    const estimatedRealLoss = Math.round(pipelineAtRisk * this.defaultCloseRate);

    return {
      totalLeads: leads.length,
      contactedCount: contacted.length,
      uncontactedCount: uncontacted.length,
      leakedCount: leaked.length,
      leakRatio: leads.length > 0 ? Math.round((leaked.length / leads.length) * 100) : 0,
      medianResponseMinutes: Math.round(medianResponseMinutes),
      totalPipelineValue,
      pipelineAtRisk,
      estimatedRealLoss,
      tierBreakdown: {
        elite: results.filter(r => r.slaStatus === 'HEALTHY').length,
        acceptable: results.filter(r => r.slaStatus === 'WARNING').length,
        highRisk: results.filter(r => r.slaStatus === 'DEGRADED').length,
        breached: results.filter(r => r.slaStatus === 'BREACHED').length
      },
      auditDetails: results
    };
  }
}

class FunnelSimulator {
  /**
   * Simulates a typical business funnel and calculates quantifiable revenue loss.
   */
  static simulateFunnel({ totalLeads = 100, contactRate = 0.72, qualifyRate = 0.57, proposalRate = 0.46, closeRate = 0.37, avgDealSize = 1500 }) {
    const contacted = Math.round(totalLeads * contactRate);
    const leakedBeforeContact = totalLeads - contacted;
    const qualified = Math.round(contacted * qualifyRate);
    const proposals = Math.round(qualified * proposalRate);
    const customers = Math.round(proposals * closeRate);

    const actualRevenue = customers * avgDealSize;
    
    // Counterfactual: If all 100 were contacted within SLA
    const potentialContacted = totalLeads;
    const potentialQualified = Math.round(potentialContacted * qualifyRate);
    const potentialProposals = Math.round(potentialQualified * proposalRate);
    const potentialCustomers = Math.round(potentialProposals * closeRate);
    const potentialRevenue = potentialCustomers * avgDealSize;

    const lostRevenueToLeadLeak = potentialRevenue - actualRevenue;

    return {
      funnel: [
        { stage: 'Inbound Leads', count: totalLeads, pct: 100 },
        { stage: 'Contacted', count: contacted, pct: Math.round((contacted / totalLeads) * 100) },
        { stage: 'Qualified', count: qualified, pct: Math.round((qualified / totalLeads) * 100) },
        { stage: 'Proposals Sent', count: proposals, pct: Math.round((proposals / totalLeads) * 100) },
        { stage: 'Closed Won', count: customers, pct: Math.round((customers / totalLeads) * 100) }
      ],
      leakedBeforeContact,
      leakPercentage: Math.round((leakedBeforeContact / totalLeads) * 100),
      actualRevenue,
      potentialRevenue,
      lostRevenueToLeadLeak,
      avgDealSize
    };
  }
}

class RecoveryDispatcher {
  /**
   * Dispatches automated multi-channel recovery sequence to all leaked leads.
   */
  static dispatchRecovery(leakedLeads, repPool = ['Sarah (Senior Rep)', 'Marcus (Inbound)', 'Alex (SDR)']) {
    const recovered = [];
    const timestamp = new Date().toISOString();

    leakedLeads.forEach((lead, index) => {
      const assignedRep = repPool[index % repPool.length];
      let hook = '';

      if (lead.channel === 'whatsapp') {
        hook = `Hi ${lead.name || 'there'}, thanks for reaching out on WhatsApp! Apologies for the delay. Are you available for a quick 2-minute chat about your request?`;
      } else if (lead.channel === 'phone_call') {
        hook = `[Instant SMS] Hi ${lead.name || 'there'}, we noticed you called earlier! We were assisting another client. Would you like to book a quick callback or chat here?`;
      } else {
        hook = `Hi ${lead.name || 'there'}, thank you for contacting us via our site. I've personally reviewed your request and would love to get your quote over. When is best today?`;
      }

      recovered.push({
        leadId: lead.id || lead.leadId,
        name: lead.name,
        channel: lead.channel,
        dealValue: lead.dealValue,
        recoveryStatus: 'DISPATCHED',
        assignedRep,
        dispatchedAt: timestamp,
        recoveryChannel: lead.channel === 'phone_call' ? 'SMS' : lead.channel,
        actionHook: hook
      });
    });

    const recoveredValue = recovered.reduce((sum, r) => sum + (r.dealValue || 0), 0);

    return {
      recoveredCount: recovered.length,
      recoveredValue,
      dispatchedAt: timestamp,
      records: recovered
    };
  }
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  generateLeadFingerprint,
  SLA_TIERS,
  LeadIngestionEngine,
  DeduplicationEngine,
  SlaAuditor,
  FunnelSimulator,
  RecoveryDispatcher
};
