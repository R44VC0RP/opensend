import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { authSession, authUser } from './google-auth.js';

// @better-auth/mcp / oauth-provider 1.7.3 and the JWT plugin. Keep every plugin
// field mapped, including optional fields: the adapter selects whole records.
export const authJwks = pgTable('auth_jwks', {
  id: text('id').primaryKey(), publicKey: text('public_key').notNull(), privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'), crv: text('crv'),
});
export const oauthClient = pgTable('oauth_client', {
  id: text('id').primaryKey(), clientId: text('client_id').notNull().unique(), clientSecret: text('client_secret'),
  clientDiscoveryId: text('client_discovery_id'), disabled: boolean('disabled').default(false), skipConsent: boolean('skip_consent'),
  enableEndSession: boolean('enable_end_session'), subjectType: text('subject_type'), scopes: text('scopes').array(),
  clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
  userId: text('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }), updatedAt: timestamp('updated_at', { withTimezone: true }),
  name: text('name'), uri: text('uri'), icon: text('icon'), contacts: text('contacts').array(), tos: text('tos'), policy: text('policy'),
  softwareId: text('software_id'), softwareVersion: text('software_version'), softwareStatement: text('software_statement'),
  redirectUris: text('redirect_uris').array().notNull(), postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
  backchannelLogoutUri: text('backchannel_logout_uri'), backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method'), applicationType: text('application_type'), jwks: text('jwks'), jwksUri: text('jwks_uri'),
  grantTypes: text('grant_types').array(), responseTypes: text('response_types').array(), requirePKCE: boolean('require_pkce'),
  dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false), referenceId: text('reference_id'), metadata: jsonb('metadata'),
}, t => [index('oauth_client_user_idx').on(t.userId)]);
export const oauthResource = pgTable('oauth_resource', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull().unique(), name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'), refreshTokenTtl: integer('refresh_token_ttl'), signingAlgorithm: text('signing_algorithm'), signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(), customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false), disabled: boolean('disabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }), updatedAt: timestamp('updated_at', { withTimezone: true }), policyVersion: integer('policy_version').default(1), metadata: jsonb('metadata'),
});
export const oauthClientResource = pgTable('oauth_client_resource', {
  id: text('id').primaryKey(), clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  // The provider stores the RFC 8707 identifier here, not the resource row ID.
  resourceId: text('resource_id').notNull().references(() => oauthResource.identifier, { onDelete: 'cascade' }),
  metadata: jsonb('metadata'), createdAt: timestamp('created_at', { withTimezone: true }),
}, t => [uniqueIndex('oauth_client_resource_pair_idx').on(t.clientId, t.resourceId), index('oauth_client_resource_resource_idx').on(t.resourceId)]);
export const oauthRefreshToken = pgTable('oauth_refresh_token', {
  id: text('id').primaryKey(), token: text('token').notNull().unique(), clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => authSession.id, { onDelete: 'set null' }), userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'), authorizationCodeId: text('authorization_code_id'), resources: text('resources').array(), requestedUserInfoClaims: text('requested_user_info_claims').array(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), revoked: timestamp('revoked', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }), rotationReplayResponse: text('rotation_replay_response'), rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
  authTime: timestamp('auth_time', { withTimezone: true }), confirmation: jsonb('confirmation'), scopes: text('scopes').array().notNull(),
}, t => [index('oauth_refresh_client_idx').on(t.clientId), index('oauth_refresh_session_idx').on(t.sessionId), index('oauth_refresh_user_idx').on(t.userId), index('oauth_refresh_code_idx').on(t.authorizationCodeId)]);
export const oauthAccessToken = pgTable('oauth_access_token', {
  id: text('id').primaryKey(), token: text('token').notNull().unique(), clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => authSession.id, { onDelete: 'set null' }), userId: text('user_id').references(() => authUser.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'), authorizationCodeId: text('authorization_code_id'), resources: text('resources').array(), requestedUserInfoClaims: text('requested_user_info_claims').array(),
  refreshId: text('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  revoked: timestamp('revoked', { withTimezone: true }), confirmation: jsonb('confirmation'), scopes: text('scopes').array().notNull(),
}, t => [index('oauth_access_client_idx').on(t.clientId), index('oauth_access_session_idx').on(t.sessionId), index('oauth_access_user_idx').on(t.userId), index('oauth_access_code_idx').on(t.authorizationCodeId), index('oauth_access_refresh_idx').on(t.refreshId)]);
export const oauthConsent = pgTable('oauth_consent', {
  id: text('id').primaryKey(), clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => authUser.id, { onDelete: 'cascade' }), referenceId: text('reference_id'),
  resources: text('resources').array(), requestedUserInfoClaims: text('requested_user_info_claims').array(), scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, t => [index('oauth_consent_client_idx').on(t.clientId), index('oauth_consent_user_idx').on(t.userId), uniqueIndex('oauth_consent_grant_idx').on(t.clientId, t.userId, t.referenceId)]);
export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const mcpAuthSchema = { jwks: authJwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion };
