import { BadRequestException } from '@nestjs/common';
import {
  canTeamMove,
  excerpt,
  isClosed,
  requestReference,
  sanitizeDetails,
} from './customer-request.mapper';
import { EMAIL_EXCERPT_LENGTH, TEAM_TRANSITIONS } from './customer-requests.constants';

describe('sanitizeDetails', () => {
  it('keeps only the type’s own fields, trimmed, and drops empty values', () => {
    expect(
      sanitizeDetails('domain', {
        desiredDomain: '  nour.example ',
        alreadyOwned: false,
        registrar: '',
      }),
    ).toEqual({ desiredDomain: 'nour.example', alreadyOwned: false });
  });

  it('refuses a field that belongs to another type', () => {
    expect(() => sanitizeDetails('logo', { desiredDomain: 'x.test' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses the wrong kind and an over-long value', () => {
    expect(() => sanitizeDetails('domain', { alreadyOwned: 'yes' })).toThrow(
      BadRequestException,
    );
    expect(() => sanitizeDetails('logo', { brandName: 'x'.repeat(121) })).toThrow(
      BadRequestException,
    );
    expect(() => sanitizeDetails('logo', { style: { nested: true } })).toThrow(
      BadRequestException,
    );
  });

  it('accepts no details at all', () => {
    expect(sanitizeDetails('custom_feature', undefined)).toEqual({});
  });
});

describe('the team lifecycle', () => {
  it('never lets the team cancel (that is the customer’s decision)', () => {
    for (const targets of Object.values(TEAM_TRANSITIONS)) {
      expect(targets).not.toContain('cancelled');
    }
  });

  it('treats declined and cancelled as final, and lets a completed request be reopened', () => {
    expect(TEAM_TRANSITIONS.rejected).toEqual([]);
    expect(TEAM_TRANSITIONS.cancelled).toEqual([]);
    expect(canTeamMove('completed', 'in_progress')).toBe(true);
    expect(canTeamMove('completed', 'rejected')).toBe(false);
  });

  it('knows which statuses are closed', () => {
    expect(isClosed('completed')).toBe(true);
    expect(isClosed('rejected')).toBe(true);
    expect(isClosed('cancelled')).toBe(true);
    expect(isClosed('waiting_for_customer')).toBe(false);
  });
});

describe('references and excerpts', () => {
  it('builds a short upper-case reference from the id', () => {
    expect(requestReference('0f3c9a12-7b44-4c1e-9d0a-1234567890ab')).toBe('CR-0F3C9A12');
  });

  it('caps an email excerpt', () => {
    const long = 'a'.repeat(EMAIL_EXCERPT_LENGTH + 50);
    expect(excerpt(long)).toHaveLength(EMAIL_EXCERPT_LENGTH);
    expect(excerpt('short')).toBe('short');
  });
});
