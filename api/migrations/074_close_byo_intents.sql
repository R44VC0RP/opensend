SET LOCAL lock_timeout='1s';
-- Preserve a terminal result for Settings without reserving the name or either quota.
ALTER TABLE byo_domain_intents ADD COLUMN closed_reason text;
UPDATE byo_domain_intents i SET closed_reason=j.last_error FROM jobs j
WHERE j.id='byo.bind:'||i.id AND j.type='byo.bind' AND j.status='failed' AND j.payload->>'connectionId'=i.connection_id
  AND j.last_error IN ('CANDIDATE_NO_LONGER_VERIFIED','DOMAIN_CLAIMED','DOMAIN_REGION_CONFLICT','DOMAIN_CLAIM_EXPIRED','DOMAIN_LIMIT_REACHED');
