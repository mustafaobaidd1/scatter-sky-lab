/**
 * npm run validate — computes every validation number quoted in the README and the "How it works"
 * panel, writes src/generated/validation.json and prints a Markdown summary.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { it } from 'vitest';
import { colourStats } from '../src/physics/analysis';
import { AEROSOL_PRESETS, type AerosolPresetId } from '../src/physics/aerosol';
import {
  buildAtmosphere,
  DEFAULT_CONFIG,
  verticalOpticalDepths,
  type AtmosphereConfig,
} from '../src/physics/atmosphere';
import { CIE_D65_5NM } from '../src/physics/data/cie';
import { cmfWeights, spectrumToXyz, xyzToLinearSrgb } from '../src/physics/colour';
import { STANDARD_AIR_NUMBER_DENSITY } from '../src/physics/constants';
import { buildColumnLut, distanceToTop, integrateColumns, lookupColumns } from '../src/physics/lut';
import { computeDustOptics, dustPhase } from '../src/physics/marsDust';
import { mieSphere } from '../src/physics/mie';
import {
  airCrossSection,
  airKingFactor,
  airOpticalDepth,
  renderingRayleighBeta,
} from '../src/physics/rayleigh';
import { dirFromAngles, traceRay, type Scene } from '../src/physics/sky';
import { hatAverage, wavelengthGrid } from '../src/physics/spectral';

const GRID = wavelengthGrid(16);
const FINE = wavelengthGrid(69);
const DUST = computeDustOptics(wavelengthGrid(35), { radii: 64 });

function scene(cfg: Partial<AtmosphereConfig>, sunEl: number, grid = GRID): Scene {
  const atm = buildAtmosphere({ ...DEFAULT_CONFIG, ...cfg }, grid, DUST);
  return {
    atm,
    lut: buildColumnLut(atm),
    irradiance: null,
    altitude: 0.002,
    sunDir: dirFromAngles(sunEl, 180),
  };
}

function colour(sc: Scene, el: number, azFromSun: number, steps = 64, useLut = true) {
  const r = traceRay(sc, dirFromAngles(el, 180 + azFromSun), { steps, useLut, sunSteps: 256 });
  return colourStats(
    sc.atm.lambdas,
    r.rayleigh.map((v, i) => v + r.aerosol[i]),
  );
}

const round = (v: number, d: number) => Number(v.toFixed(d));

it('computes and records validation results', () => {
  // 1. Rayleigh vs Bodhaine et al. (1999) Table 3.
  const bodhaine: [number, number, number, number][] = [
    [400, 1.6738e-26, 0.36022, 1.05126],
    [440, 1.1273e-26, 0.24261, 1.0503],
    [550, 4.5105e-27, 0.097069, 1.04882],
    [680, 1.9035e-27, 0.040963, 1.04802],
    [700, 1.6926e-27, 0.036424, 1.04793],
  ];
  const rayleigh = bodhaine.map(([nm, sigma, tau, king]) => {
    const s = airCrossSection(nm) * 1e4;
    const t = airOpticalDepth(nm);
    return {
      nm,
      sigmaModel: s,
      sigmaRef: sigma,
      tauModel: round(t, 6),
      tauRef: tau,
      kingModel: round(airKingFactor(nm), 5),
      kingRef: king,
      tauDiffPercent: round((t / tau - 1) * 100, 4),
    };
  });

  // 2. The widely used rendering constants.
  const renderingConstants = [
    [680, 5.802e-6],
    [550, 13.558e-6],
    [440, 33.1e-6],
  ].map(([nm, beta]) => {
    const physical = airCrossSection(nm) * STANDARD_AIR_NUMBER_DENSITY;
    return {
      nm,
      rendering: beta,
      reproduced: round(renderingRayleighBeta(nm), 9),
      physical: round(physical, 9),
      ratio: round(beta / physical, 4),
    };
  });

  // 3. Zenith transmittance identity for every preset.
  let zenithWorst = 0;
  for (const preset of Object.keys(AEROSOL_PRESETS) as AerosolPresetId[]) {
    const sc = scene({ aerosolPreset: preset }, 45);
    const ray = traceRay({ ...sc, altitude: 0 }, [0, 1, 0], { steps: 128, useLut: false });
    for (let i = 0; i < GRID.length; i++) {
      const t = verticalOpticalDepths(sc.atm, i);
      zenithWorst = Math.max(
        zenithWorst,
        Math.abs(ray.transmittance[i] / Math.exp(-(t.rayleigh + t.aerosol + t.ozone)) - 1),
      );
    }
  }

  // 4. LUT accuracy: relative error where τ > 0.1, absolute error below.
  let lutWorstRel = 0;
  let lutWorstAbs = 0;
  {
    const sc = scene({ aerosolPreset: 'volcanic' }, 45);
    const { atm, lut } = sc;
    const R = atm.bottomRadius;
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    for (const h of [0, 0.3, 2, 7, 15, 22, 30, 45, 60, 90]) {
      for (const mu of [1, 0.6, 0.25, 0.08, 0.02, 0, -0.03, -0.08, -0.12]) {
        const r = R + h;
        if (mu < -Math.sqrt(Math.max(0, 1 - (R / r) ** 2)) + 1e-4) continue;
        lookupColumns(lut, r, mu, a);
        integrateColumns(atm, r, mu, distanceToTop(r, mu, atm.topRadius), 4000, b);
        for (let i = 0; i < GRID.length; i++) {
          const ta =
            atm.molSca[i] * a[0] + atm.aExt[i] * a[1] + atm.bExt[i] * a[2] + atm.ozoneAbs[i] * a[3];
          const tb =
            atm.molSca[i] * b[0] + atm.aExt[i] * b[1] + atm.bExt[i] * b[2] + atm.ozoneAbs[i] * b[3];
          if (tb > 0.1) lutWorstRel = Math.max(lutWorstRel, Math.abs(ta / tb - 1));
          else lutWorstAbs = Math.max(lutWorstAbs, Math.abs(ta - tb));
        }
      }
    }
  }

  // 5. Spectral sampling: 16 wavelengths vs the 5 nm reference.
  const scenes: [string, Partial<AtmosphereConfig>, number, number, number][] = [
    ['noon zenith', {}, 60, 90, 0],
    ['sunset horizon', {}, 1, 2, 10],
    ['smoke, 40°', { aerosolPreset: 'smoke' }, 20, 40, 60],
    ['Mars, beside the setting sun', { planet: 'mars' }, 2, 4, 2],
  ];
  const sampling = scenes.map(([name, cfg, sunEl, el, az]) => {
    const c = colour(scene(cfg, sunEl), el, az);
    const f = colour(scene(cfg, sunEl, FINE), el, az);
    return {
      name,
      deltaE: round(Math.hypot(c.a - f.a, c.b - f.b), 3),
      deltaY: round((c.luminance / f.luminance - 1) * 100, 3),
    };
  });

  // 6. Fast path (LUT, 48 steps) vs reference (direct sunward integral, 512 steps).
  const fastScenes: [string, Partial<AtmosphereConfig>, number, number, number][] = [
    ['afternoon', {}, 45, 70, 30],
    ['sunset horizon', {}, 0.5, 1.5, 8],
    ['blue hour zenith', {}, -4, 89, 0],
    ['volcanic twilight', { aerosolPreset: 'volcanic' }, -2, 20, 0],
  ];
  const fastPath = fastScenes.map(([name, cfg, sunEl, el, az]) => {
    const sc = scene(cfg, sunEl);
    const f = colour(sc, el, az, 48, true);
    const r = colour(sc, el, az, 512, false);
    return {
      name,
      deltaE: round(Math.hypot(f.a - r.a, f.b - r.b), 3),
      deltaY: round((f.luminance / r.luminance - 1) * 100, 3),
    };
  });

  // 7. Qualitative physics.
  const dom = (c: ReturnType<typeof colour>) => ({
    dominant: c.dominant ? round(c.dominant.wavelength, 1) : null,
    complementary: c.dominant?.complementary ?? false,
    purity: c.dominant ? round(c.dominant.purity, 3) : 0,
    hue: round(c.hue, 1),
    b: round(c.b, 2),
    luminance: round(c.luminance, 1),
  });
  const qualitative = {
    noonZenith: dom(colour(scene({}, 60), 90, 0)),
    sunsetHorizon: dom(colour(scene({}, 0.5), 1.5, 8)),
    lambda0Zenith: dom(colour(scene({ rayleighExponent: 0 }, 60), 90, 0)),
    blueHourZenithOzone: dom(colour(scene({}, -4), 89, 0)),
    blueHourZenithNoOzone: dom(colour(scene({ ozone: false }, -4), 89, 0)),
    marsNoonZenith: dom(colour(scene({ planet: 'mars' }, 60), 90, 0)),
    marsBesideSettingSun: dom(colour(scene({ planet: 'mars' }, 2), 4, 2)),
    marsFarFromSettingSun: dom(colour(scene({ planet: 'mars' }, 2), 20, 40)),
  };

  // 8. Mie theory vs Wiscombe (1979) MIEV0 and Bohren & Huffman.
  const xBH = (2 * Math.PI * 0.525) / 0.6328;
  const mie = [
    {
      case: 'BH sample m=1.55, x=5.213',
      ref: { qsca: 3.10543, qback: 2.92534, g: 0.63314 },
      got: mieSphere(xBH, 1.55, 0),
    },
    {
      case: 'MIEV0 m=1.33+1e-5i, x=100',
      ref: { qsca: 2.096594, g: 0.868959 },
      got: mieSphere(100, 1.33, 1e-5),
    },
    {
      case: 'MIEV0 m=0.75, x=10',
      ref: { qsca: 2.232265, g: 0.896473 },
      got: mieSphere(10, 0.75, 0),
    },
    {
      case: 'MIEV0 m=10+10i, x=100',
      ref: { qsca: 1.836785, g: 0.556215 },
      got: mieSphere(100, 10, 10),
    },
  ].map((m) => ({
    case: m.case,
    qscaRef: m.ref.qsca,
    qsca: round(m.got.qsca, 6),
    gRef: m.ref.g,
    g: round(m.got.g, 6),
  }));
  const at650 = computeDustOptics([650], { radii: 64 });
  const i440 = DUST.lambdas.indexOf(440);
  const i670 = DUST.lambdas.indexOf(670);
  const dust = {
    ssa440: round(DUST.ssa[i440], 4),
    ssa650: round(at650.ssa[0], 4),
    ssa650Ref: 0.975,
    ssa670: round(DUST.ssa[i670], 4),
    g440: round(DUST.g[i440], 4),
    g670: round(DUST.g[i670], 4),
    forwardPeakRatio3deg: round(
      dustPhase(DUST, i440, Math.cos((3 * Math.PI) / 180)) /
        dustPhase(DUST, i670, Math.cos((3 * Math.PI) / 180)),
      3,
    ),
  };

  // 9. D65 white balance.
  const d65 = hatAverage(CIE_D65_5NM, FINE);
  const rgb = xyzToLinearSrgb(spectrumToXyz(d65, cmfWeights(FINE)));
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const d65Balance = round(Math.max(...rgb.map((c) => Math.abs(c / mean - 1))) * 100, 4);

  // 10. Air mass from the model.
  const sc = scene({}, 45);
  const R = sc.atm.bottomRadius;
  const z = lookupColumns(sc.lut, R, 1, new Float64Array(4))[0];
  const airMass = [10, 5, 1.3, 0].map((e) => ({
    elevation: e,
    model: round(
      lookupColumns(sc.lut, R, Math.sin((e * Math.PI) / 180), new Float64Array(4))[0] / z,
      2,
    ),
  }));
  // Horizon air mass of an exponential atmosphere without refraction (Chapman): √(πR / 2H).
  const chapmanHorizon = round(Math.sqrt((Math.PI * R) / (2 * sc.atm.molScaleHeight)), 2);

  const result = {
    generated: new Date().toISOString().slice(0, 10),
    rayleigh,
    renderingConstants,
    zenithTransmittanceWorstPercent: round(zenithWorst * 100, 4),
    lutWorstRelativePercent: round(lutWorstRel * 100, 3),
    lutWorstAbsoluteSmallTau: round(lutWorstAbs, 5),
    sampling,
    fastPath,
    qualitative,
    mie,
    dust,
    d65BalancePercent: d65Balance,
    airMass,
    chapmanHorizon,
  };
  mkdirSync('src/generated', { recursive: true });
  writeFileSync('src/generated/validation.json', JSON.stringify(result, null, 2) + '\n');

  const lines = [
    '| Check | Reference | Model |',
    '|---|---|---|',
    ...rayleigh.map(
      (r) =>
        `| Rayleigh τ at ${r.nm} nm (sea level, 45° N) | ${r.tauRef} (Bodhaine et al. 1999) | ${r.tauModel} (${r.tauDiffPercent >= 0 ? '+' : ''}${r.tauDiffPercent} %) |`,
    ),
    `| Zenith T vs exp(−τR−τA−τO3), all presets | identity | worst ${result.zenithTransmittanceWorstPercent} % |`,
    `| LUT optical depth vs 4000-step integral | — | worst ${result.lutWorstRelativePercent} % (τ > 0.1), ${result.lutWorstAbsoluteSmallTau} absolute (τ ≤ 0.1) |`,
    ...sampling.map(
      (s) => `| 16 λ vs 5 nm, ${s.name} | ΔE*ab = 0 | ${s.deltaE} (ΔY ${s.deltaY} %) |`,
    ),
    ...fastPath.map(
      (s) =>
        `| GPU path (LUT, 48 steps) vs reference, ${s.name} | ΔE*ab = 0 | ${s.deltaE} (ΔY ${s.deltaY} %) |`,
    ),
    ...mie.map((m) => `| Mie ${m.case}: Q_sca, g | ${m.qscaRef}, ${m.gRef} | ${m.qsca}, ${m.g} |`),
    `| Mars dust ω at 650 nm | 0.975 (Wolff et al. 2009 via Chen-Chen et al. 2019) | ${dust.ssa650} |`,
    `| D65 → linear sRGB balance (5 nm) | equal | max deviation ${d65Balance} % |`,
    `| Air mass at the horizon (exponential, no refraction) | √(πR/2H) = ${chapmanHorizon} | ${airMass[3].model} |`,
  ];
  process.stdout.write(
    '\n' +
      lines.join('\n') +
      '\n\n' +
      JSON.stringify(qualitative, null, 1) +
      '\n' +
      JSON.stringify(airMass) +
      '\n',
  );
}, 600_000);
