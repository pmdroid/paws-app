/**
 * Command evidence is accepted only from a producer this process trusts.
 *
 * The default trust set is `paws-closeout` at this evaluator's version.
 * Conformance records from the reference runner need an explicit opt-in for
 * `closeout-reference` at the fixture version.
 */

/** Producer name this in-process evaluator writes and trusts. */
export const PAWS_CLOSEOUT_NAME = "paws-closeout";

/**
 * Running version of this evaluator. A `paws-closeout` command record must
 * carry this version. It is the evaluator contract, not a package publish.
 */
export const PAWS_CLOSEOUT_VERSION = "0.1.0";

/** Reference runner producer name. Trusted only when conformance asks for it. */
export const CLOSEOUT_REFERENCE_NAME = "closeout-reference";

/**
 * `closeout` crate version at `SPEC_COMMIT` (`baac33e`). Conformance fixtures
 * substitute this for `$version`.
 */
export const CLOSEOUT_REFERENCE_VERSION = "0.1.0";

export type TrustedProducer = {
  name: string;
  version: string;
};

/**
 * Who may have written a command record.
 *
 * `paws-closeout` at {@link PAWS_CLOSEOUT_VERSION} is always trusted.
 * Set `trustReference` to also trust `closeout-reference` at
 * `referenceVersion` (the fixture version unless overridden).
 * `also` adds further name and version pairs.
 */
export type EvaluateTrust = {
  trustReference?: boolean;
  referenceVersion?: string;
  also?: readonly TrustedProducer[];
};

export function trustedProducers(trust?: EvaluateTrust): readonly TrustedProducer[] {
  const producers: TrustedProducer[] = [
    { name: PAWS_CLOSEOUT_NAME, version: PAWS_CLOSEOUT_VERSION },
  ];
  if (trust?.trustReference === true) {
    producers.push({
      name: CLOSEOUT_REFERENCE_NAME,
      version: trust.referenceVersion ?? CLOSEOUT_REFERENCE_VERSION,
    });
  }
  if (trust?.also) producers.push(...trust.also);
  return producers;
}

export function producerTrusted(
  name: string,
  version: string,
  trust: EvaluateTrust | undefined,
): boolean {
  return trustedProducers(trust).some(
    (producer) => producer.name === name && producer.version === version,
  );
}
