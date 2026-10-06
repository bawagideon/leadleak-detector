# Integration & Deployment Guide: LeadLeak Detector

## 1. Integration Boundaries
* **Webhook Listeners:** Subscribes to incoming POST payloads from Webflow, WordPress, Typeform, HubSpot, and Twilio voice/SMS callbacks.
* **Normalization Engine:** In-memory canonical E.164 and SHA-256 fingerprint deduplication with zero external dependencies.
* **Notification Connectors:** Slack incoming webhooks, Twilio REST API for SMS dispatch, WhatsApp Business Cloud API.
* **CRM Egress:** HubSpot Contacts API, Salesforce REST API, or Google Sheets append.

## 2. Environment Configuration
```env
PORT=3001
SLA_TARGET_MINUTES=5
SLA_CRITICAL_MINUTES=120
TWILIO_ACCOUNT_SID=AC_live_xxx
TWILIO_AUTH_TOKEN=xxx
SLACK_ALERT_WEBHOOK=https://hooks.slack.com/services/xxx
CRM_ENDPOINT=https://api.hubspot.com/crm/v3/objects/contacts
```

## 3. Edge-Case Invariants
* **Empty Payload / Missing Fields:** Safely defaults to anonymous prospect with generated tracking ID.
* **Malformed Phone / Email:** Bypasses formatting without throw; flags for manual rep validation.
* **Duplicate Submission Spikes:** Deduplicates multiple rapid form clicks within 60 seconds into a single canonical event.
* **Unreachable Downstream CRM:** Queues dispatches locally with exponential retry backoff.
