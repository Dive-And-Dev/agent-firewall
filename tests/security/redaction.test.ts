import { describe, it, expect } from 'vitest';
import { redact } from '../../src/security/redaction.js';

describe('redact', () => {
  // Block-level: PEM keys
  it('redacts PEM private key blocks', () => {
    const input = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...base64...\n-----END RSA PRIVATE KEY-----\nafter';
    const result = redact(input);
    expect(result).toContain('<REDACTED_PRIVATE_KEY_BLOCK>');
    expect(result).not.toContain('MIIE');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('redacts OpenSSH private key blocks', () => {
    const input = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r...\n-----END OPENSSH PRIVATE KEY-----';
    const result = redact(input);
    expect(result).toContain('<REDACTED_PRIVATE_KEY_BLOCK>');
    expect(result).not.toContain('b3BlbnNzaC1r');
  });

  it('redacts certificate blocks', () => {
    const input = '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----';
    const result = redact(input);
    expect(result).toContain('<REDACTED_CERT_BLOCK>');
  });

  // Token-level: API keys
  it('redacts OpenAI keys preserving prefix', () => {
    const input = 'key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
    const result = redact(input);
    expect(result).toContain('sk-***REDACTED***');
    expect(result).not.toContain('abc123');
  });

  it('redacts Anthropic keys preserving prefix', () => {
    const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789';
    const result = redact(input);
    expect(result).toContain('sk-ant-***REDACTED***');
  });

  it('redacts GitHub PATs preserving prefix', () => {
    const input = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh';
    const result = redact(input);
    expect(result).toContain('ghp_***REDACTED***');
  });

  it('redacts github_pat_ tokens', () => {
    const input = 'github_pat_abcdefghijklmnopqrstuvwx';
    const result = redact(input);
    expect(result).toContain('github_pat_***REDACTED***');
  });

  it('redacts Slack tokens preserving prefix', () => {
    const input = 'SLACK_TOKEN=xoxb-123456789-abcdefghij';
    const result = redact(input);
    expect(result).toContain('xoxb-***REDACTED***');
  });

  it('redacts JWTs', () => {
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redact(input);
    expect(result).toContain('<REDACTED_JWT>');
  });

  it('redacts AWS access keys', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redact(input);
    expect(result).toContain('AKIA***REDACTED***');
  });

  it('redacts Bearer tokens in Authorization headers', () => {
    const input = 'Authorization: Bearer sk-abc123def456ghi789jkl012';
    const result = redact(input);
    expect(result).not.toContain('abc123');
  });

  // KV-level
  it('redacts PASSWORD= values', () => {
    const input = 'PASSWORD=mysupersecretpassword';
    const result = redact(input);
    expect(result).toBe('PASSWORD=<REDACTED>');
  });

  it('redacts JSON "private_key" values', () => {
    const input = '"private_key": "-----BEGIN RSA PRIVATE KEY-----\\nMIIE..."';
    const result = redact(input);
    expect(result).toContain('"private_key": "<REDACTED>"');
  });

  it('redacts secret= values case-insensitively', () => {
    const input = 'CLIENT_SECRET=abcdef123456789';
    const result = redact(input);
    expect(result).toBe('CLIENT_SECRET=<REDACTED>');
  });

  // False-positive avoidance
  it('does NOT redact normal git SHA (40 hex chars)', () => {
    const input = 'commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const result = redact(input);
    expect(result).toBe(input);
  });

  it('does NOT redact UUIDs', () => {
    const input = 'session_id: 550e8400-e29b-41d4-a716-446655440000';
    const result = redact(input);
    expect(result).toBe(input);
  });

  it('does NOT redact short strings below min length', () => {
    const input = 'token=ab';
    const result = redact(input);
    expect(result).toBe(input);
  });
});
