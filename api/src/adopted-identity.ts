import { createHash } from 'node:crypto';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';

// Normalize only stable, observable identity facts. Don't persist unrelated SES tags or policies.
export function adoptionFacts(s:Partial<GetEmailIdentityCommandOutput>) {
  const d=s.DkimAttributes,m=s.MailFromAttributes;
  return {defaultSet:s.ConfigurationSetName??null,dkimOrigin:d?.SigningAttributesOrigin??null,dkimZone:d?.SigningHostedZone??null,
    dkimTokens:[...(d?.Tokens??[])].sort(),mailFrom:m?.MailFromDomain??null,mailFromBehavior:m?.BehaviorOnMxFailure??null};
}
export const adoptionFingerprint=(facts:ReturnType<typeof adoptionFacts>)=>createHash('sha256').update(JSON.stringify(facts)).digest('hex');
export function matchesAdoption(s:Partial<GetEmailIdentityCommandOutput>,fingerprint:string) {
  return s.IdentityType==='DOMAIN' && s.VerifiedForSendingStatus===true && s.VerificationStatus==='SUCCESS' && s.DkimAttributes?.SigningEnabled===true && s.DkimAttributes.Status==='SUCCESS' &&
    (!s.MailFromAttributes?.MailFromDomain || s.MailFromAttributes.MailFromDomainStatus==='SUCCESS') && adoptionFingerprint(adoptionFacts(s))===fingerprint;
}
