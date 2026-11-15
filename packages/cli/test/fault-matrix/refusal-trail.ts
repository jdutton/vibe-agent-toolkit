/**
 * Every value the refusal path handed `errorMessageOf` since `runVerb` last cleared it, in order.
 * `refusal-observer.ts` fills it; a module of its own because a mock factory may not reach a
 * binding its module exports.
 */
export const refusalTrail: unknown[] = [];
