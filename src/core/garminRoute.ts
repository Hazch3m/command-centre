/**
 * Where Garmin requests go. Normally the PC calls Garmin itself; with cloud
 * sync on, the sync service holds the Garmin sign-in, so every Garmin request
 * (PC and phone) goes through it. Garmin's refresh token changes each time
 * it's used, so only one place may use it.
 */
export type GarminVia = <T = unknown>(path: string) => Promise<{ status: number; body: T }>;
let via: GarminVia | null = null;
export const setGarminVia = (f: GarminVia | null) => {
  via = f;
};
export const garminVia = () => via;

/** Creating and scheduling workouts (POST/PUT/DELETE on Garmin's workout service), routed the same way. */
export type GarminWriteVia = <T = unknown>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: T }>;
let writeVia: GarminWriteVia | null = null;
export const setGarminWriteVia = (f: GarminWriteVia | null) => {
  writeVia = f;
};
export const garminWriteVia = () => writeVia;
