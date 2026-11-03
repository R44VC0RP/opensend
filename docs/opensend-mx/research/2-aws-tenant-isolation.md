**Use a customer-owned IAM role for BYO AWS. For hosted sending, distinguish tenant-level protection from account-level isolation.** SES tenants can pause one sender without pausing the others, but AWS explicitly says their combined activity “still affects your overall account reputation.” If one workspace must not put another’s SES account standing at risk, use **one OpenSend-owned AWS member account per workspace**, with shared application infrastructure. If Mode B must use one AWS account, offer it as a pooled mode with that limitation—not the same guarantee. [AWS tenant guide, Trust & Safety](https://docs.aws.amazon.com/ses/latest/dg/tenants.html#integration-with-aws-trust-safety)

### A. Bring your own AWS

Offer a [CloudFormation quick-create link](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html) to a versioned template. The customer reviews the policy and creates the role. OpenSend generates a unique external ID per connection; the customer cannot choose another workspace’s ID. Trust **only** the OpenSend broker role:

```json
{"Version":"2012-10-17","Statement":[{
  "Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<MX_ACCOUNT>:role/OpenSendBroker"},
  "Action":"sts:AssumeRole","Condition":{"StringEquals":{"sts:ExternalId":"<CONNECTION_ID>"}}
}]}
```

Give the broker `sts:AssumeRole` on registered role ARNs. Before enabling a connection, verify assumption succeeds with the correct ID, fails without it, and returns the expected account. Cache short-lived sessions by connection; fence queued jobs by **connection version**, not by rotating STS credentials as the [current fingerprint does](/api/src/ses-region-state.ts#L15). For strict BYO isolation, do not connect two workspaces to the same AWS account. **No pasted-key fallback at launch:** IAM user keys require custody and manual rotation; the role is revocable without sharing a customer secret. [AWS third-party guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html)

Role ARN and external ID are identifiers, not passwords. For any necessary persisted secret, use a fresh AES-256 data key, Worker Web Crypto AES-GCM with a random 96-bit IV, and workspace/connection/purpose/version as authenticated data. Wrap the data key under an OpenSend KMS key with matching encryption context; store only ciphertext, IV, wrapped key and key version. Keep STS credentials in memory. Do not reuse the [auth-derived webhook key](/api/src/config.ts#L41). [AWS envelope encryption](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html)

#### BYO permissions for today’s implementation

Render the following JSON **per approved region**. Replace uppercase resource placeholders with exact ARNs: `IDENTITY` and `TEMPLATE` are customer-approved resources (expand arrays for multiple); `TX`, `MKT`, `FEEDBACK`, `INBOUND` and `BUCKET` are generated installation resources. `BUCKET` is the full S3 ARN. Update the stack when authorizing additional domains. This is the combined action inventory; keep provisioning permissions off the normal sending session. Source-reviewed, not live-tested.

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["ses:GetAccount","ses:ListEmailIdentities","cloudwatch:GetMetricData","ses:ApplyTrackingConfigurationOverrides"],"Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"REGION"}}},
  {"Effect":"Allow","Action":["ses:GetEmailIdentity","ses:CreateEmailIdentity","ses:PutEmailIdentityMailFromAttributes"],"Resource":"IDENTITY"},
  {"Effect":"Allow","Action":["ses:GetConfigurationSet","ses:CreateConfigurationSet","ses:TagResource","ses:GetConfigurationSetEventDestinations","ses:CreateConfigurationSetEventDestination","ses:UpdateConfigurationSetEventDestination","ses:PutConfigurationSetSuppressionOptions"],"Resource":["TX","MKT"]},
  {"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":["IDENTITY","TX","MKT"]},
  {"Effect":"Allow","Action":["ses:GetEmailTemplate","ses:TestRenderEmailTemplate"],"Resource":"TEMPLATE"},
  {"Effect":"Allow","Action":["sns:CreateTopic","sns:TagResource","sns:ListTagsForResource","sns:SetTopicAttributes","sns:ListSubscriptionsByTopic"],"Resource":["FEEDBACK","INBOUND"]},
  {"Effect":"Allow","Action":["sns:GetTopicAttributes","sns:GetSubscriptionAttributes","sns:SetSubscriptionAttributes"],"Resource":"FEEDBACK"},
  {"Effect":"Allow","Action":"sns:Subscribe","Resource":["FEEDBACK","INBOUND"],"Condition":{"StringEquals":{"sns:Protocol":"https","sns:Endpoint":"https://opensend.mx/v1/events/ses"}}},
  {"Effect":"Allow","Action":["ses:DescribeActiveReceiptRuleSet","ses:DescribeReceiptRuleSet","ses:CreateReceiptRuleSet","ses:SetActiveReceiptRuleSet","ses:CreateReceiptRule","ses:UpdateReceiptRule","ses:DeleteReceiptRule"],"Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"REGION"}}},
  {"Effect":"Allow","Action":["s3:ListBucket","s3:CreateBucket","s3:PutBucketOwnershipControls","s3:PutBucketTagging","s3:PutBucketPublicAccessBlock","s3:PutBucketPolicy","s3:PutLifecycleConfiguration"],"Resource":"BUCKET"},
  {"Effect":"Allow","Action":"s3:GetObject","Resource":["BUCKET/raw/*","BUCKET/att/*"]},
  {"Effect":"Allow","Action":"s3:PutObject","Resource":"BUCKET/att/*"}
]}
```

| Permission group | Code evidence |
|---|---|
| Account, identity, configuration sets, suppression, metrics | [Discovery: 223–264; metrics: 323; creation/tags/destinations: 383–405; suppression: 60](/api/src/ses-setup.ts#L223); [identity reads/creation/MAIL FROM: 153, 203–219](/api/src/operations.ts#L203). `GetCallerIdentity` [needs no IAM allow](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html). |
| Sending, tracking, templates | [Simple/raw MIME: 202–206; send and tracking overrides: 332–338](/api/src/dispatcher.ts#L202); [template reads/render: 527–529](/api/src/sending.ts#L527). [Tracking permission requires `*`](https://docs.aws.amazon.com/ses/latest/dg/configuration-overrides.html). |
| SNS | [Feedback reads: 272–297; creation, tags, policy and subscription: 391–422](/api/src/ses-setup.ts#L272); [inbound: 118–128](/api/src/mailbox-setup.ts#L118). [SNS resource scopes](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sns.html). |
| Receiving and storage | [Bucket setup: 98–114; rule sets: 132–137; rule mutations: 192–194](/api/src/mailbox-setup.ts#L98); [raw read/attachment write: 81, 121](/api/src/mailbox-ingest.ts#L81); [signed downloads: 230](/api/src/mailbox.ts#L230). [Classic receipt actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html) cannot be ARN-scoped. |

`s3:PutObject` on `raw/*` and `sns:Publish` belong to **SES**, via resource policies constrained by `SourceAccount` and source rule/configuration-set ARN—not the OpenSend role. No IAM administration, account-wide suppression-list CRUD, or mailbox `DeleteObject` is needed. The [general attachment adapter](/api/src/adapters/storage.ts#L24) uses separate storage credentials.

### B. Pooled hosted sending

[SES tenant management launched August 1, 2025](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies/) in all SES regions. In each sending region:

1. `CreateTenant` per workspace; exclusively associate verified identities, both configuration sets and any SES templates via `CreateTenantResourceAssociation`. Require `SendEmail.TenantName` and the associated configuration set; restrict the sending session using [`ses:TenantName`](https://aws.amazon.com/blogs/messaging-and-targeting/implement-tenants-in-your-amazon-ses-environment-part-3-implementation-guide/). Disable account-wide [identity import](/api/src/ses-regions.ts#L37) and [adoption by name](/api/src/operations.ts#L203); require independent DNS ownership and reject overlapping domain claims.
2. Set `PutTenantSuppressionAttributes` to `TENANT`, reasons `BOUNCE` and `COMPLAINT`. Remove the [current `ACCOUNT` configuration-set override](/api/src/ses-setup.ts#L60): **configuration sets take precedence**. Use tenant-dimensioned reputation metrics, not [account-wide alerts](/api/src/reputation-alerts.ts#L47). [Suppression precedence](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level.html)
3. Use `UpdateReputationEntityPolicy`: **Strict** pauses on any finding; Standard, the default, pauses on high severity; None disables automated pausing. Config sets and tags alone route and label traffic; they do not isolate enforcement. An exclusive [standard dedicated IP pool](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html) separates IP reputation after warm-up, not account standing. Even separate accounts using shared IPs cannot guarantee independent inbox placement.

**Capacity:** Per account/region: 10,000 tenants by default (qualifying increases to 300,000), 10,000 verified identities, 10,000 configuration sets by default, ten destinations/set. Two sets/workspace means **5,000 pooled workspaces before a set-quota increase**, even with tenant headroom. À-la-carte tenant pricing: **$0.005/tenant/month + $0.005/1,000 emails**. Sandbox: verified recipients or simulator, 200 recipients/24 hours, one/second. Each BYO customer requests production access per region; hosted accounts need their own approvals. Production daily/rate limits remain account-regional, not per SES tenant. [Quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) · [Sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [Pricing](https://aws.amazon.com/ses/pricing/)

### Receiving and events

**Receiving is not tenant-aware.** Use the [regional receiving endpoint](https://docs.aws.amazon.com/ses/latest/dg/regions.html), typically `inbound-smtp.<region>.amazonaws.com`, not the custom MAIL FROM endpoint. Only receiving-supported regions qualify. Classic SES allows 40 rule sets but **one active**, 200 rules/set, 500 recipient conditions/rule, ten actions/rule. In BYO, join the existing active set; never replace it. In pooled accounts, serialize reconciliation per **account/region**, pack verified domains into rules feeding a private S3/SNS ingress, then split by authenticated receipt **envelope recipients**, never MIME headers. Give each workspace only its recipient subset and authorized objects; never expose the shared notification or another workspace’s Bcc recipients. [Receiving semantics](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html) · [Quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)

**Prefer SNS HTTPS for delivery feedback in both modes.** Use a dedicated outbound topic per connection/region and separate inbound topic. Register exact ARN→connection/purpose before confirming; validate [SNS signatures](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html), sender account, configuration set and workspace-owned provider message ID. Never route by a caller tag alone. Carry the resolved workspace through the queue, deduplicate by topic/message ID, and acknowledge only after durable enqueue. Today the [handler assumes a deployment workspace](/api/src/operations.ts#L349). EventBridge is useful for tenant reputation findings. For BYO delivery events it requires a [source default-bus rule](https://docs.aws.amazon.com/ses/latest/dg/monitoring-eventbridge.html), forwarding role and [destination bus policy](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-cross-account.html); it does not remove the inbound S3/SNS path.

**Open decisions:** Is zero shared account-reputation exposure contractual? **Use member accounts.** May BYO customers decline broad receipt-rule permissions? **Yes; offer send-only onboarding.** Has the policy been exercised against AWS? **No credentials were used; gate release on an authorized disposable-account test of raw/structured sends, provisioning, signed feedback and mixed-workspace recipients.**
