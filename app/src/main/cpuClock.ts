/**
 * What the processor is actually running at, right now.
 *
 * `os.cpus()[i].speed` is not it. On Windows it comes from the registry value written at boot and
 * never moves — measured here at a flat 2995 MHz on all twenty cores while the real clock swung —
 * so the window was showing "3.0 GHz" as though it were a live reading of an idle machine.
 *
 * Task Manager's own figure is the base clock times the `% Processor Performance` counter, and that
 * counter does move: 106.9 % and 119.4 % two seconds apart on an idle machine here. So:
 *
 *   - the base clock is `MaxMhz` from `CallNtPowerInformation(ProcessorInformation)` — instant, in
 *     process, and the same 1400 MHz `Win32_Processor.MaxClockSpeed` reports for this Core Ultra
 *     (its `CurrentMhz` is NOT live: 1400/900 flat while the counter swung, so it is not used);
 *   - the performance percentage comes from PDH, a handful of microseconds per sample.
 *
 * The base used to come from a PowerShell WMI query: five to ten seconds on this machine, asked once
 * with a ten-second limit and never again — so under load the answer never arrived, the nominal
 * figure stood in for it for the life of the process, and the user saw the clock "fixed at 3 GHz".
 * On any machine where either source is missing this reports null and the caller falls back to
 * the nominal figure.
 */
import os from "node:os";

/** PDH's "give me a double" format. */
const PDH_FMT_DOUBLE = 0x00000200;
/** The counter is English-named on every locale when added with the English API. */
const PERFORMANCE_COUNTER = "\\Processor Information(_Total)\\% Processor Performance";

interface Pdh {
  open: () => number | null;
  read: () => number | null;
}

let pdh: Pdh | null | undefined;
let query: number | null = null;
let counter: number | null = null;
let baseMhz: number | null | undefined;

function loadPdh(): Pdh | null {
  if (pdh !== undefined) return pdh;
  if (process.platform !== "win32") return (pdh = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const lib = koffi.load("pdh.dll");
    // The value union is 8-byte aligned, so the status word is followed by four bytes of padding.
    const VALUE = koffi.struct("PDH_FMT_COUNTERVALUE", {
      status: "uint32",
      padding: "uint32",
      value: "double",
    });
    const PdhOpenQueryW = lib.func("__stdcall", "PdhOpenQueryW", "long",
      ["void *", "uintptr", koffi.out(koffi.pointer("uintptr"))]);
    const PdhAddEnglishCounterW = lib.func("__stdcall", "PdhAddEnglishCounterW", "long",
      ["uintptr", "str16", "uintptr", koffi.out(koffi.pointer("uintptr"))]);
    const PdhCollectQueryData = lib.func("__stdcall", "PdhCollectQueryData", "long", ["uintptr"]);
    const PdhGetFormattedCounterValue = lib.func("__stdcall", "PdhGetFormattedCounterValue", "long",
      ["uintptr", "uint32", koffi.out(koffi.pointer("uint32")), koffi.out(koffi.pointer(VALUE))]);

    return (pdh = {
      open: () => {
        const out: number[] = [0];
        if (PdhOpenQueryW(null, 0, out) !== 0) return null;
        const handle = out[0] as number;
        const counterOut: number[] = [0];
        if (PdhAddEnglishCounterW(handle, PERFORMANCE_COUNTER, 0, counterOut) !== 0) return null;
        counter = counterOut[0] as number;
        // A rate counter needs one collection to have something to rate against.
        PdhCollectQueryData(handle);
        return handle;
      },
      read: () => {
        if (query === null || counter === null) return null;
        if (PdhCollectQueryData(query) !== 0) return null;
        const type: number[] = [0];
        const out = [{ status: 0, padding: 0, value: 0 }];
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, type, out) !== 0) return null;
        const reading = out[0]?.value;
        return typeof reading === "number" && Number.isFinite(reading) ? reading : null;
      },
    });
  } catch (error) {
    console.error("[hangar] live clock unavailable:", (error as Error).message);
    return (pdh = null);
  }
}

/** POWER_INFORMATION_LEVEL for CallNtPowerInformation: one PROCESSOR_POWER_INFORMATION per processor. */
const PROCESSOR_INFORMATION = 11;

/**
 * The processor's base clock in MHz, read once through powrprof — or null where it cannot be read.
 * Enough room is passed for every logical processor; only the first entry is used.
 */
function baseClockMhz(): number | null {
  if (baseMhz !== undefined) return baseMhz;
  if (process.platform !== "win32") return (baseMhz = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const INFO = koffi.struct("PROCESSOR_POWER_INFORMATION", {
      Number: "uint32", MaxMhz: "uint32", CurrentMhz: "uint32", MhzLimit: "uint32", MaxIdleState: "uint32", CurrentIdleState: "uint32",
    });
    const CallNtPowerInformation = koffi.load("powrprof.dll").func("__stdcall", "CallNtPowerInformation", "long",
      ["int", "void *", "uint32", koffi.out(koffi.pointer(INFO)), "uint32"]);
    const count = Math.max(1, os.cpus().length);
    const out = Array.from({ length: count }, () => ({ Number: 0, MaxMhz: 0, CurrentMhz: 0, MhzLimit: 0, MaxIdleState: 0, CurrentIdleState: 0 }));
    if (CallNtPowerInformation(PROCESSOR_INFORMATION, null, 0, out, count * koffi.sizeof(INFO)) !== 0) return (baseMhz = null);
    const mhz = out[0]?.MaxMhz ?? 0;
    return (baseMhz = mhz > 0 ? mhz : null);
  } catch (error) {
    console.error("[hangar] base clock unavailable:", (error as Error).message);
    return (baseMhz = null);
  }
}

/**
 * The live clock in GHz, or null while it cannot be known.
 *
 * Called once per sample; everything expensive happens on the first call or not at all.
 */
export function liveClockGhz(): number | null {
  const api = loadPdh();
  if (!api) return null;
  const base = baseClockMhz();
  if (base === null) return null;
  if (query === null) query = api.open();
  if (query === null) return null;
  const percent = api.read();
  if (percent === null || percent <= 0) return null;
  return (base * percent) / 100 / 1000;
}
