/** Default `retrieveK` — passes a dozen hybrid hits to the ask model. */
export const RETRIEVE_K_DEFAULT = 12;

/** Floor on `retrieveK`; below this the ask model can't ground answers. */
export const RETRIEVE_K_MIN = 4;

/** Ceiling on `retrieveK`; bounds the prompt size for large-K queries. */
export const RETRIEVE_K_MAX = 30;
