/**
 * An injectable clock for the plans module.
 *
 * Every access decision in this module is a function of one subscription
 * row and the current instant. Reading `new Date()` inline made that
 * instant impossible to control from a test — the expiry-enforcement
 * regression suite needs to stand exactly 1 ms either side of
 * `currentPeriodEnd` and the sweep needs to be run "later" without
 * sleeping. Production always gets the real clock (`SystemClock`); nothing
 * outside this module depends on the token.
 */
import { Injectable } from '@nestjs/common';

export interface Clock {
  now(): Date;
}

export const PLANS_CLOCK = Symbol('PLANS_CLOCK');

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
