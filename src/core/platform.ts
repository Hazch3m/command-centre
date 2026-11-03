import { backend } from "@backend";

/**
 * Running as the phone app. Its data comes from the PC, so the cards' own
 * "Offline" and sync buttons don't apply there.
 */
export const onPhone = backend.kind === "phone";
