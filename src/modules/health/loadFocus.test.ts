import { describe, expect, it } from "vitest";
import { parseLoadFocus } from "./data";

describe("Garmin load focus", () => {
  it("reads the primary device's 4-week load and optimal ranges", () => {
    const body = {
      mostRecentTrainingLoadBalance: {
        metricsTrainingLoadBalanceDTOMap: {
          "123": { calendarDate: "2026-11-09", monthlyLoadAerobicLow: 1, monthlyLoadAerobicHigh: 1, monthlyLoadAnaerobic: 1, monthlyLoadAerobicLowTargetMin: 1, monthlyLoadAerobicLowTargetMax: 2, monthlyLoadAerobicHighTargetMin: 1, monthlyLoadAerobicHighTargetMax: 2, monthlyLoadAnaerobicTargetMin: 1, monthlyLoadAnaerobicTargetMax: 2, primaryTrainingDevice: false },
          "456": {
            calendarDate: "2026-11-09",
            monthlyLoadAerobicLow: 620.4,
            monthlyLoadAerobicHigh: 742.1,
            monthlyLoadAnaerobic: 33,
            monthlyLoadAerobicLowTargetMin: 610,
            monthlyLoadAerobicLowTargetMax: 930,
            monthlyLoadAerobicHighTargetMin: 560,
            monthlyLoadAerobicHighTargetMax: 1010,
            monthlyLoadAnaerobicTargetMin: 250,
            monthlyLoadAnaerobicTargetMax: 590,
            trainingBalanceFeedbackPhrase: "ANAEROBIC_SHORTAGE",
            primaryTrainingDevice: true,
          },
        },
      },
    };
    const lf = parseLoadFocus(body)!;
    expect(lf.high).toBeCloseTo(742.1);
    expect(lf.target.anaerobic).toEqual([250, 590]);
    expect(lf.phrase).toBe("ANAEROBIC_SHORTAGE");
    expect(parseLoadFocus({ nothing: true })).toBeNull();
  });
});
