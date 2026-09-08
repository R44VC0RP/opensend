# Credentials and IAM for OpenSend

[Hub](README.md)

Research date: **2026-09-08**. Scope: an API-based transactional/marketing wrapper around Amazon SES v2.
This is reference documentation, not an implemented integration, deployed IAM policy, or evidence of a live customer-account test.

## Status and trust boundaries

**Verified facts** below come from current official AWS documentation; **recommended design** describes proposed OpenSend behavior; **unverified constraints** identify checks still required before shipping.
Context7 was consulted for AWS/STS/SES documentation, then the official service authorization reference (SAR), API reference, and developer guide were read directly. The current SAR is authoritative for the examples: older summaries saying SES only supports resource scoping for sending are incomplete for SES v2. [S1–S3]

Keep these mechanisms distinct:

| Mechanism | What it grants | What it does not grant |
| --- | --- | --- |
| IAM role trust policy | A named platform principal may call `sts:AssumeRole`, subject to conditions | SES permissions by itself |
| Role permissions policy | The assumed session may call selected AWS actions against selected resources | Permission for an arbitrary principal to assume the role |
| SES sending authorization policy on an identity | A delegate may send using that identity, in its Region | General SES account administration or the ability to assume an IAM role |
| OpenSend application authorization | A workspace member/API key may request allowed OpenSend operations | AWS authorization or proof of domain ownership |

Sending authorization can use the delegate's own AWS account; AssumeRole instead operates as a principal in the customer's AWS account. These are different billing, quota, reputation, and incident boundaries. [S4, S5]

## Recommended connection: cross-account AssumeRole

**Verified facts.** STS returns an access key ID, secret access key, session token, and expiration. SES API calls support temporary credentials. Session policies can reduce, but not expand, the role's permissions. Cross-account use requires the role's trust and permission on the calling side. Role chaining has a one-hour maximum session; do not assume a role configured for a longer maximum overrides that limit. [S4, S6]

**Recommended design — enrollment sequence:**

1. Authenticate the OpenSend workspace administrator. Generate a unique, platform-assigned random ExternalId for the customer account connection; bind it to the workspace and account, not a browser-supplied arbitrary role ARN.
2. Give the customer the exact platform execution-role ARN, ExternalId, chosen SES Regions, and separate capability policy examples. The customer creates the role in their account using their own AWS administration workflow.
3. On the server, assume only the registered role with that connection's ExternalId and a non-sensitive, traceable role-session name. Test that assuming the same role without the ExternalId and with an incorrect ExternalId fails. AWS explicitly recommends rejecting enrollment if the role can be assumed without the correct ExternalId. [S5]
4. Call `GetCallerIdentity` using the returned credentials. Match `Account` and assumed-role `Arn` against the registered connection; do not trust an account ID typed into a form. Then read SES in each selected Region to determine actual capabilities.
5. Store verified metadata and a secret-store reference, not temporary credentials in UI state. Refresh credentials server-side before expiration with concurrency control; stop queued sends when a connection is revoked.

`GetCallerIdentity` returns `Account`, `Arn`, and `UserId`. AWS says no permission grant is required, even when an identity policy explicitly denies `sts:GetCallerIdentity`. It identifies the caller; it does **not** prove SES access, production status, root-free credential provenance, or DNS ownership. [S7]

### ExternalId is confused-deputy protection, not a password

The platform, not the customer, assigns a unique ExternalId. AWS recommends one per AWS account in a multi-tenant service. A malicious customer must not be able to submit another customer's role ARN and cause the platform to use the victim's ExternalId. Keep server-side workspace/account/role binding authoritative. AWS does not treat ExternalId as a secret: users who can inspect the role can see it. Security rests on the trusted principal **and** correctly bound ExternalId, not obscurity. [S5]

### Example A — customer role trust policy

All IDs and names below are illustrative placeholders. `111122223333` is the platform account; `444455556666` is the customer account. Replace them, the role names, Region, identity, and ExternalId before use. These examples assume the commercial `aws` partition, not GovCloud or China.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "TrustOnlyOpenSendExecutionRole",
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::111122223333:role/OpenSendExecution"},
    "Action": "sts:AssumeRole",
    "Condition": {"StringEquals": {"sts:ExternalId": "opensend-generated-unique-account-id"}}
  }]
}
```

**Recommended design:** use an exact execution-role principal rather than trusting every identity in the platform account. The named principal must exist when the trust is configured. Recreating a principal can require updating trust; do not silently broaden trust to fix it. Do not add `iam:*`, `sts:*`, MFA bypasses, or a wildcard principal.

### Example B — platform execution-role permission

This policy belongs to the platform caller, not the customer SES role. It is separate from customer-side trust.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AssumeRegisteredCustomerRole",
    "Effect": "Allow",
    "Action": "sts:AssumeRole",
    "Resource": "arn:aws:iam::444455556666:role/OpenSendConnection"
  }]
}
```

In a larger fleet, generate bounded registrations rather than recommending `Resource: "*"`. An IAM permission boundary, SCP, session policy, resource policy, or explicit deny can still block a request; these examples are not an override for organizational controls. [S4, S5]

## IAM action mapping: do not copy API names blindly

Both classic SES and SES v2 use the IAM prefix **`ses`**, not `sesv2`. Consult the v2 SAR's API-operation mapping and action tables, not just SDK command names. The following reflects the documentation retrieved on the research date. [S1, S2]

| Operation / transport | IAM authorization to plan for | Resource / condition notes |
| --- | --- | --- |
| v2 `GetAccount` | `ses:GetAccount` | No resource type: use `Resource: "*"`; constrain requested Region |
| v2 `ListEmailIdentities`, `ListConfigurationSets`, `ListEmailTemplates` | Same-name `ses:` actions | Account/Region listing; no per-item resource ARN scope |
| v2 `GetEmailIdentity` | `ses:GetEmailIdentity` | Identity ARN |
| v2 `SendEmail` (Simple, Raw, or Template content) | `ses:SendEmail` in v2 action table | Identity required; configuration-set and template resources when used; content-specific live authorization remains a release check |
| v2 `SendBulkEmail` | **`ses:SendBulkEmail`**, explicitly mapped in current v2 SAR | Identity and template are marked required; configuration-set supported; see inline-template caveat below |
| Classic `SendRawEmail` / SMTP | `ses:SendRawEmail` | Do not grant just because OpenSend uses v2 Raw content; SMTP needs this action |
| Classic `SendTemplatedEmail`, `SendBulkTemplatedEmail` | Respective classic actions | Not substitutes for v2 send grants |
| v2 stored template CRUD/render | `ses:CreateEmailTemplate`, `GetEmailTemplate`, `UpdateEmailTemplate`, `DeleteEmailTemplate`, `TestRenderEmailTemplate` | Template ARN; listing separately uses `*` |

**Important current distinction:** the v2 bulk action is not inferred to be `ses:SendEmail` or `ses:SendBulkTemplatedEmail`. The current official API-operation mapping explicitly lists `ses:SendBulkEmail`. The bulk action lists `ses:ApiVersion`, `ses:MultiRegionEndpointId`, `ses:TenantName`, and resource-tag conditions; it does **not** list `ses:FromAddress`, `ses:Recipients`, or `ses:FeedbackAddress`. Do not copy a single-send From-address condition onto a bulk statement and assume the same enforcement. [S1]

For single-send, the SAR lists `ses:FromAddress`, `ses:FromDisplayName`, `ses:FeedbackAddress`, and multi-valued `ses:Recipients`. A display-name restriction is not an address restriction. Recipient constraints need appropriate set operators and missing-key handling. Use explicit application-level sender/recipient validation as well as IAM, especially for bulk. `ses:TenantName` and `ses:MultiRegionEndpointId` are conditions, not replacement identity/template resource ARNs. [S1]

### Example C — read/connect, no sending or mutation

The wildcard below is necessary for account/list operations; it is **not** `ses:*` administration. Omit list grants if the customer supplies exact resource names and does not want account-wide discovery. Scope getters to approved resources.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadRegionalAccountAndDiscoverResources",
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:ListEmailIdentities", "ses:ListConfigurationSets", "ses:ListEmailTemplates"],
      "Resource": "*",
      "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-1"}}
    },
    {
      "Sid": "ReadApprovedIdentity",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": "arn:aws:ses:us-east-1:444455556666:identity/example.com"
    },
    {
      "Sid": "ReadApprovedConfigurationSet",
      "Effect": "Allow",
      "Action": ["ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations"],
      "Resource": "arn:aws:ses:us-east-1:444455556666:configuration-set/opensend-transactional"
    },
    {
      "Sid": "ReadApprovedTemplates",
      "Effect": "Allow",
      "Action": "ses:GetEmailTemplate",
      "Resource": "arn:aws:ses:us-east-1:444455556666:template/opensend-*"
    }
  ]
}
```

`aws:RequestedRegion` is an AWS global condition key that controls the invoked endpoint, not every cross-Region side effect. It is not a sufficient data-residency guard for Global endpoints or replication. ARN Region scoping, explicit feature controls, and separate multi-region policy review are still needed. [S8]

### Example D — sending grants, separated by stream

Attach only the stream statements actually requested. This example uses a **stored** template for marketing bulk mail and a pre-existing configuration set per stream. It gives no template modification, identity creation, suppression deletion, or account-setting permissions. [S1]

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TransactionalSingleSend",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:us-east-1:444455556666:identity/example.com",
        "arn:aws:ses:us-east-1:444455556666:configuration-set/opensend-transactional",
        "arn:aws:ses:us-east-1:444455556666:template/opensend-transactional-*"
      ],
      "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-1", "ses:FromAddress": "receipts@example.com"}}
    },
    {
      "Sid": "MarketingStoredTemplateBulkSend",
      "Effect": "Allow",
      "Action": "ses:SendBulkEmail",
      "Resource": [
        "arn:aws:ses:us-east-1:444455556666:identity/example.com",
        "arn:aws:ses:us-east-1:444455556666:configuration-set/opensend-marketing",
        "arn:aws:ses:us-east-1:444455556666:template/opensend-marketing-*"
      ],
      "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-1"}}
    }
  ]
}
```

A resource allow-list does not itself require callers to specify a configuration set when the API allows omission. OpenSend should always select a registered configuration set, reject unregistered names, and inspect identity defaults; test this invariant at the service boundary. Likewise, the bulk example allows sending from the approved domain, not only one mailbox. Use a narrower separately verified email identity when appropriate, and validate bulk From addresses in OpenSend.

**Optional tenant restriction:** for a tenant-specific sender, add `"ses:TenantName": "opensend-customer-a"` to `StringEquals` on the relevant send statement, and use only resources associated with that tenant. This requires the request to supply the tenant name; do not use `StringEqualsIfExists` if omission must be denied. A tenant ARN is not listed as the send action's resource type. [S1, S13]

### Example E — separately approved template-authoring grant

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AuthorOnlyOpenSendMarketingTemplates",
    "Effect": "Allow",
    "Action": ["ses:CreateEmailTemplate", "ses:GetEmailTemplate", "ses:UpdateEmailTemplate", "ses:TestRenderEmailTemplate"],
    "Resource": "arn:aws:ses:us-east-1:444455556666:template/opensend-marketing-*"
  }]
}
```

Deletion is deliberately omitted; grant `ses:DeleteEmailTemplate` only for an explicit delete capability. Sending with a stored template is separate from reading or editing its body. Namespace prefixes are policy boundaries only when all applicable grants preserve them. [S1]

## Optional administration: separate opt-in grants

**Verified action/resource inventory, recommended separation.** These are not an instruction to attach every row. Prefix every listed SES action with `ses:`; use the current SAR for supported tags, required resources, and dependencies. Do not solve a denied optional feature by adding `ses:*`. [S1]

| Optional feature | Candidate actions | Resource / caveat |
| --- | --- | --- |
| Domain creation/authentication | `CreateEmailIdentity`, `PutEmailIdentityDkimAttributes`, `PutEmailIdentityDkimSigningAttributes`, `PutEmailIdentityMailFromAttributes` | Exact approved identity ARNs; BYODKIM private key is a secret; no DNS permission implied |
| Identity defaults / feedback | `PutEmailIdentityConfigurationSetAttributes`, `PutEmailIdentityFeedbackAttributes`; classic notification actions if used | Identity scoped for v2; check classic SAR separately for legacy actions |
| Sending authorization editing | `CreateEmailIdentityPolicy`, `UpdateEmailIdentityPolicy`, `DeleteEmailIdentityPolicy`, `GetEmailIdentityPolicies` | Identity ARN; delegation/security-sensitive, not normal connect access |
| DEED | `ReplicateEmailIdentityDKIMSigningKey` plus replica `CreateEmailIdentity` | Parent identity ARN and `ses:ReplicaRegion` allow-list; separate grants in replica Region [S14] |
| Configuration sets | `CreateConfigurationSet`, `GetConfigurationSet`, selected `PutConfigurationSet…` actions | Configuration-set ARN; select each setting explicitly, no blanket wildcard suffix |
| Event destinations | `CreateConfigurationSetEventDestination`, `UpdateConfigurationSetEventDestination`, `GetConfigurationSetEventDestinations`, optionally delete | Configuration-set ARN; some destination paths require `iam:PassRole` and service-side destination permissions |
| Contacts | `CreateContact`, `GetContact`, `UpdateContact`, `ListContacts`, optionally `DeleteContact` | Contact-list ARN, not an individual email-address ARN |
| Contact-list management | `CreateContactList`, `GetContactList`, `UpdateContactList`, optionally delete; `ListContactLists` for discovery | Named contact-list ARNs; discovery is `*`; deletion affects subscribers |
| Account suppression | `GetSuppressedDestination`, `ListSuppressedDestinations`, separately `PutSuppressedDestination` / `DeleteSuppressedDestination` | Account-mode operations need account-level scope, not a fabricated recipient ARN; sensitive personal data and safety controls |
| Tenant suppression | Same destination actions with tenant selection; `PutTenantSuppressionAttributes` for configuration | Current SAR supports tenant resource scope; use full returned tenant ARN and test account-mode omission is denied [S13] |
| Production request / account settings | `PutAccountDetails`, selected `PutAccount…` operations | No resource ARN; `*` with Region constraint; customer approval and separate administration path |
| Pricing-plan changes | `PutAccountPricingAttributes` | Billing-changing regional admin write; never include in read/connect or ordinary sending. Read `GetAccount.PricingAttributes` instead; see [cost reference](limits-costs-and-operations.md) |
| Tenant provisioning | `CreateTenant`, `GetTenant`, `CreateTenantResourceAssociation`, selected reputation-management operations | Full tenant ARN and associated resource ARNs; association is not ordinary sending |

For DEED, an example parent-side statement is `Action: "ses:ReplicateEmailIdentityDKIMSigningKey"`, `Resource: "arn:aws:ses:us-east-1:444455556666:identity/example.com"`, with `ForAllValues:StringEquals` on `ses:ReplicaRegion` to `["us-west-2"]`. Add a `Null: {"ses:ReplicaRegion": "false"}` check if treating presence as an invariant; multi-valued `ForAllValues` alone can match absent context. Replica creation permissions remain separate. [S8, S14]

### Adjacent AWS services are not included in SES permissions

**Recommended design:** use a separate provisioning principal and separate event-consumer principal, leaving send workers unable to rewrite their own feedback or DNS infrastructure.

| Service/capability | Narrow scope to request only when used |
| --- | --- |
| Route 53 DNS automation | `route53:ChangeResourceRecordSets` for one hosted-zone ARN with record-name/type/action conditions; optional read/list needed by the workflow. Never automatically replace apex MX or an existing DMARC/SPF policy |
| SNS feedback | Existing topic read/subscription operations only as needed; the topic resource policy must allow SES publishing with source-account/source-ARN controls. Do not grant broad SNS administration to send workers |
| SQS event consumption | `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` on one queue; its resource policy allows only the intended SNS source; optional customer-managed KMS permissions reviewed separately |
| Firehose | SES destination role trusts SES and can put records only into the intended delivery stream; `iam:PassRole` restricted to that role and `iam:PassedToService = ses.amazonaws.com` when provisioning |
| Kinesis Data Streams | Not interchangeable with Firehose. Add stream access only if an explicitly designed pipeline uses it; it is not a generic SES send dependency |
| CloudWatch | Optional metric reads such as `cloudwatch:GetMetricData`, `GetMetricStatistics`, `ListMetrics`; metric-read IAM resource limitations may require `*`. No CloudWatch read permission needed merely to submit an SES email |
| EventBridge | Rule/target provisioning and service permissions only for the chosen feedback or tenant-status route; distinct from SES send grants |
| Billing / Cost Explorer | Optional cost-reporting actions such as `ce:GetCostAndUsage`, with separate review of payer/linked-account data exposure; `GetAccount` does not return a complete AWS bill |
| Service-linked roles | Only for explicitly enabled features that require them, with `iam:AWSServiceName` restriction; never blanket `iam:*` or unrestricted `iam:PassRole` |

The table is a design inventory, not a validated universal policy for those services. Verify each destination's official setup and service SAR before generating grants, including customer-managed KMS keys, cross-account subscription ownership, and Region requirements. [S1, S15–S18]

## Fallback: long-lived IAM user access keys

**Verified facts:** an API access key pair is not an SMTP username/password. SMTP passwords are Region-specific derivatives of IAM user secret keys; AWS explicitly says not to derive SMTP credentials from temporary security credentials. STS role credentials therefore cannot be repurposed as working SMTP credentials. An SMTP-only credential cannot power SES API onboarding, account discovery, or identity administration. [S3, S9]

**Recommended design:** prefer AssumeRole. If a customer cannot use it, offer an explicitly labeled API-key fallback for a dedicated least-privilege IAM user, never root credentials, console passwords, or broadly privileged human-user keys. Use the same SES capability policies, with no IAM credential-management privileges granted to OpenSend. Do not ask customers to create SMTP users for this API integration.

A secure enrollment form may transmit a fallback secret once over TLS to a server-side secret store; “no browser credentials” means no AWS credentials returned to or retained in the client, no client-side AWS SDK signing, no localStorage/sessionStorage, and no credentials in URLs, analytics, replay tools, logs, or error reports. Disable instrumentation on secret inputs. Prefer a server-to-server secret import option when available.

### Storage, rotation, and revocation recommendations

- Encrypt customer credentials with a managed secret store/KMS-backed mechanism; authorize reads by connection and service role. Keep only secret references in ordinary records. Never persist a BYODKIM private key or fallback key in source control.
- Cache STS credentials only server-side for their lifetime. Include connection/account/role/ExternalId in cache identity; never share credential caches across tenants. Treat session tokens, signed Authorization headers, and SDK debug dumps as secrets.
- Redact secrets before structured logging, tracing, support export, and exception capture. Log operation, connection identifier, Region, AWS request ID, result category, and non-sensitive session reference instead of full requests or mail bodies.
- For fallback rotation, accept a new dedicated-user key, verify account identity and allowed read operations, switch the secret reference atomically, then have the customer deactivate and delete the old key after verification. Do not request IAM key-creation privileges simply to automate rotation. [S19]
- Disconnect stops new assumptions and new jobs, clears caches, and removes stored fallback secrets according to retention policy. Changing role trust stops new sessions but is not a promise of immediate revocation of previously issued sessions: customers can revoke active role sessions using AWS's deny policy mechanism. Keep incident revocation separate from routine logout. [S10]

## Validation boundary and unverified constraints

The JSON examples are documentation examples checked against the cited action/resource tables and for JSON syntax, **not** IAM Access Analyzer-validated policies or live AWS authorization tests. No AWS changes, credentials, sends, or customer integration tests were performed for this research.

Before production rollout, validate the generated policy and exercise an explicitly authorized real account/Region: expected reads, expected sends, prohibited identity/template/configuration-set/tenant access, omitted/wrong ExternalId, missing tenant name, and denied Regions. A simulator or source review supplements but does not replace actual service authorization behavior.

Specific open checks: v2 Raw/Template content against the exact role; inline bulk templates versus the SAR's required template resource despite no stored-template ARN; default-configuration-set behavior; cross-account delegation with bulk content; multi-region endpoint authorization in both Regions; availability of new tenant suppression features in each partition/Region. Do not grant all legacy sending actions as a speculative workaround. The v2 SAR operation table retrieved omits a `SendEmail` operation row while retaining its action row; use the API/action references and verify content-mode behavior explicitly. [S1, S11, S12]

## Sources

All sources below are official AWS documentation consulted during this research; they are mutable live pages, not immutable 2026-09-08 snapshots.

- **S1:** [SES v2 service authorization reference: operation mapping, action/resource/condition tables](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html).
- **S2:** [Classic SES service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html); [SES IAM guide](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html).
- **S3:** [SES credential types](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-credentials.html); [temporary credentials service support](https://docs.aws.amazon.com/STS/latest/UsingSTS/UsingTokens.html).
- **S4:** [STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html).
- **S5:** [Third-party roles and ExternalId](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html).
- **S6:** [STS credential comparison](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_sts-comparison.html).
- **S7:** [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html).
- **S8:** [AWS global condition keys, including RequestedRegion and multi-valued keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html).
- **S9:** [Obtaining SMTP credentials; temporary-credential prohibition](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html).
- **S10:** [Revoking IAM role sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html).
- **S11:** [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html).
- **S12:** [SES v2 SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html).
- **S13:** [SES tenants](https://docs.aws.amazon.com/ses/latest/dg/tenants.html).
- **S14:** [DEED, including replication permissions](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-deed.html).
- **S15:** [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html).
- **S16:** [Firehose event destination setup](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-firehose.html).
- **S17:** [SNS event destination setup](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html).
- **S18:** [Global endpoints and service-linked-role prerequisites](https://docs.aws.amazon.com/ses/latest/dg/global-endpoints.html).
- **S19:** [Managing IAM user access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html).
