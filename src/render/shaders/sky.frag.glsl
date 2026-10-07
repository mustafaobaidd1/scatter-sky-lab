#version 300 es
// Spectral single-scattering sky. Mirrors src/physics/sky.ts and src/render/shade.ts line by
// line; 16 wavelengths are carried as four vec4. Lengths in km, radiance in W m^-2 sr^-1 nm^-1.
// Constants prefixed LUT_/IRR_/PHASE_ are injected by the renderer from the TypeScript sources.
precision highp float;
precision highp int;
precision highp sampler2D;

#define PI 3.14159265358979
#define NG 4

uniform vec4 uMolSca[NG];
uniform vec4 uAExt[NG];
uniform vec4 uASca[NG];
uniform vec4 uAG[NG];
uniform vec4 uBExt[NG];
uniform vec4 uBSca[NG];
uniform vec4 uBG[NG];
uniform vec4 uOzone[NG];
uniform vec4 uSolar[NG];
uniform vec4 uAlbedo[NG];
uniform vec4 uLdExp[NG];
uniform vec4 uCmfX[NG];
uniform vec4 uCmfY[NG];
uniform vec4 uCmfZ[NG];

uniform float uBottomR;
uniform float uTopR;
uniform float uMolInvH;
uniform vec3 uProfA; // kind (0 exponential, 1 gaussian), 1/H or 1/width, centre
uniform vec4 uProfB; // kind, 1/H or 1/width, centre, enabled
uniform float uRayleighGamma;
uniform float uSunAngR;
uniform float uSunOmega;
uniform vec3 uSunDir;
uniform float uAltitude;
uniform int uDust;
uniform sampler2D uLut;
uniform sampler2D uIrradiance;
uniform sampler2D uDustPhase;

uniform vec3 uCamF;
uniform vec3 uCamR;
uniform vec3 uCamU;
uniform vec2 uTan;
uniform vec2 uResolution;
uniform float uPixelAngle;
uniform int uSteps;
uniform float uExposure;
uniform int uToneMap;

uniform float uHillWeight;
uniform vec4 uRidge[3]; // distance, base, slope, -
uniform vec3 uBump[18]; // 6 per layer: centre deg, width deg, height km
uniform vec3 uTerm[9]; // 3 per layer: amplitude km, frequency, phase
uniform float uFloorDepth;
uniform float uFloorElevation;
uniform float uRimAngle;

out vec4 outColor;

float sq(float x) { return x * x; }

// ---------------------------------------------------------------------------------------------
// Atmosphere

vec4 densities(float h) {
  float hc = max(h, 0.0);
  float dm = exp(-hc * uMolInvH);
  float da = uProfA.x < 0.5 ? exp(-hc * uProfA.y) : exp(-0.5 * sq((h - uProfA.z) * uProfA.y));
  float db = 0.0;
  if (uProfB.w > 0.5) {
    db = uProfB.x < 0.5 ? exp(-hc * uProfB.y) : exp(-0.5 * sq((h - uProfB.z) * uProfB.y));
  }
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return vec4(dm, da, db, dO);
}

// Columns to the top of the atmosphere from radius r (q = r² − R², passed in to avoid
// cancellation) along zenith cosine mu. Bruneton (2017) texture parametrisation.
vec4 lutColumns(float r, float q, float mu) {
  float H = sqrt(uTopR * uTopR - uBottomR * uBottomR);
  float rho = sqrt(max(q, 0.0));
  float disc = r * r * (mu * mu - 1.0) + uTopR * uTopR;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dMin = uTopR - r;
  float dMax = rho + H;
  float xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0.0;
  float xR = rho / H;
  vec2 uv = vec2(
    0.5 / LUT_W + clamp(xMu, 0.0, 1.0) * (1.0 - 1.0 / LUT_W),
    0.5 / LUT_H + clamp(xR, 0.0, 1.0) * (1.0 - 1.0 / LUT_H)
  );
  return texture(uLut, uv);
}

float sunVisibility(float r, float q, float muS) {
  float sinH = uBottomR / r;
  float cosH = -sqrt(max(q, 0.0)) / r;
  return smoothstep(-sinH * uSunAngR, sinH * uSunAngR, muS - cosH);
}

void sunTransmittance(float r, float q, float muS, out vec4 Ts[NG]) {
  float vis = sunVisibility(r, q, muS);
  if (vis <= 0.0) {
    for (int i = 0; i < NG; i++) Ts[i] = vec4(0.0);
    return;
  }
  vec4 col = lutColumns(r, q, muS);
  for (int i = 0; i < NG; i++) {
    Ts[i] = vis * exp(-(uMolSca[i] * col.x + uAExt[i] * col.y + uBExt[i] * col.z + uOzone[i] * col.w));
  }
}

float rayleighPhase(float mu) {
  float g = uRayleighGamma;
  return 3.0 / (16.0 * PI) * (1.0 + 3.0 * g + (1.0 - g) * mu * mu) / (1.0 + 2.0 * g);
}

vec4 cornetteShanks(float mu, vec4 g) {
  vec4 g2 = g * g;
  vec4 d = 1.0 + g2 - 2.0 * g * mu;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * d * sqrt(d));
}

vec4 dustPhase(int group, float mu) {
  float u = sqrt(clamp(acos(clamp(mu, -1.0, 1.0)) / PI, 0.0, 1.0));
  float x = (u * (PHASE_N - 1.0) + 0.5) / PHASE_N;
  vec4 p;
  for (int c = 0; c < 4; c++) {
    p[c] = texture(uDustPhase, vec2(x, (float(group * 4 + c) + 0.5) / 16.0)).r;
  }
  return p;
}

void irradiance(float muS, out vec4 E[NG]) {
  float u = sqrt(clamp((muS + 0.25) / 1.25, 0.0, 1.0));
  float x = (u * (IRR_N - 1.0) + 0.5) / IRR_N;
  for (int i = 0; i < NG; i++) E[i] = texture(uIrradiance, vec2(x, (float(i) + 0.5) / 4.0));
}

// Single scattering along a ray from the observer (see traceRay in sky.ts).
void traceRay(
  vec3 dir, float tMaxIn, bool ignoreGround, int steps,
  out vec4 L[NG], out vec4 T[NG], out bool hitGround, out bool missed, out float tEnd
) {
  for (int i = 0; i < NG; i++) {
    L[i] = vec4(0.0);
    T[i] = vec4(1.0);
  }
  hitGround = false;
  missed = false;
  tEnd = 0.0;
  float R = uBottomR;
  float h0 = max(uAltitude, 0.0);
  float r0 = R + h0;
  float mu0 = dir.y;
  float b = r0 * mu0;
  float cG = h0 * (2.0 * R + h0);
  float Ht = uTopR - R;
  float cT = (h0 - Ht) * (2.0 * R + h0 + Ht);
  float discT = b * b - cT;
  if (discT < 0.0) {
    missed = true;
    return;
  }
  float sqT = sqrt(discT);
  float t0 = 0.0;
  float t1 = -b + sqT;
  if (cT > 0.0) {
    t0 = -b - sqT;
    if (t1 <= 0.0) {
      missed = true;
      return;
    }
  }
  t0 = max(t0, 0.0);
  float discG = b * b - cG;
  if (discG >= 0.0 && !ignoreGround && b < 0.0) {
    float tg = cG / (-b + sqrt(discG));
    if (tg > 0.0 && tg < t1) {
      t1 = tg;
      hitGround = true;
    }
  }
  if (tMaxIn > 0.0 && tMaxIn < t1) {
    t1 = max(t0, tMaxIn);
    hitGround = false;
  }

  float nu = dot(dir, uSunDir);
  float os = r0 * uSunDir.y;
  float pR = rayleighPhase(nu);
  vec4 pA[NG];
  vec4 pB[NG];
  for (int i = 0; i < NG; i++) {
    pA[i] = uDust == 1 ? dustPhase(i, nu) : cornetteShanks(nu, uAG[i]);
    pB[i] = cornetteShanks(nu, uBG[i]);
  }

  float tLow = min(t1, max(t0, -b));
  float lenA = tLow - t0;
  float lenB = t1 - tLow;
  float total = t1 - t0;
  int nA = 0;
  int nB = 0;
  if (total > 0.0) {
    nA = lenA > 1e-9 ? max(2, int(floor(float(steps) * lenA / total + 0.5))) : 0;
    nB = lenB > 1e-9 ? max(2, steps - nA) : 0;
  }
  for (int seg = 0; seg < 2; seg++) {
    int count = seg == 0 ? nA : nB;
    float len = seg == 0 ? lenA : lenB;
    for (int k = 0; k < 128; k++) {
      if (k >= count) break;
      int kk = seg == 0 ? count - 1 - k : k;
      float u = (float(kk) + 0.5) / float(count);
      float t = seg == 0 ? tLow - len * u * u : tLow + len * u * u;
      float dt = len * 2.0 * u / float(count);
      float q = cG + t * t + 2.0 * r0 * mu0 * t;
      float qc = max(q, 0.0);
      float r = sqrt(R * R + qc);
      float h = qc / (r + R);
      float muS = (os + t * nu) / r;
      vec4 dens = densities(h);
      vec4 Ts[NG];
      sunTransmittance(r, qc, muS, Ts);
      for (int i = 0; i < NG; i++) {
        vec4 sigma = uMolSca[i] * dens.x + uAExt[i] * dens.y + uBExt[i] * dens.z + uOzone[i] * dens.w;
        vec4 tr = exp(-sigma * dt);
        vec4 f = mix(vec4(dt), (1.0 - tr) / max(sigma, vec4(1e-12)), step(vec4(1e-12), sigma));
        vec4 e = uSolar[i] * Ts[i] * T[i] * f;
        L[i] += e * (uMolSca[i] * dens.x * pR + uASca[i] * dens.y * pA[i] + uBSca[i] * dens.z * pB[i]);
        T[i] *= tr;
      }
    }
  }
  tEnd = t1;
}

// Lambertian surface at radius r = R + h (q = r² − R²) with local up and normal (shade.ts).
void surfaceRadiance(float r, float q, vec3 up, vec3 n, out vec4 S[NG]) {
  float muS = dot(up, uSunDir);
  float cosI = max(0.0, dot(n, uSunDir));
  float skyView = 0.5 * (1.0 + dot(n, up));
  vec4 Ts[NG];
  sunTransmittance(r, q, muS, Ts);
  vec4 E[NG];
  irradiance(muS, E);
  for (int i = 0; i < NG; i++) S[i] = uAlbedo[i] / PI * (uSolar[i] * Ts[i] * cosI + E[i] * skyView);
}

// ---------------------------------------------------------------------------------------------
// Scene

float ridgeHeight(int k, float az) {
  float azDeg = degrees(az);
  float h = uRidge[k].y;
  for (int j = 0; j < 6; j++) {
    vec3 bmp = uBump[k * 6 + j];
    if (bmp.z <= 0.0) continue;
    float d = mod(azDeg - bmp.x + 540.0, 360.0) - 180.0;
    h += bmp.z * exp(-0.5 * sq(d / bmp.y));
  }
  for (int j = 0; j < 3; j++) {
    vec3 tm = uTerm[k * 3 + j];
    h += tm.x * (0.5 + 0.5 * sin(tm.y * az + tm.z));
  }
  return h;
}

float ridgeElevation(int k, float az) {
  float d = uRidge[k].x;
  float drop = d * d / (2.0 * uBottomR);
  return atan(ridgeHeight(k, az) - uAltitude - drop, d);
}

// Atmosphere then ground or space, plus the solar disc (shadeOpen in shade.ts).
void shadeOpen(vec3 dir, out vec4 S[NG]) {
  vec4 L[NG];
  vec4 T[NG];
  bool hitGround;
  bool missed;
  float tEnd;
  traceRay(dir, -1.0, false, uSteps, L, T, hitGround, missed, tEnd);
  for (int i = 0; i < NG; i++) S[i] = L[i];
  if (hitGround) {
    float r0 = uBottomR + max(uAltitude, 0.0);
    vec3 p = vec3(dir.x * tEnd, r0 + dir.y * tEnd, dir.z * tEnd);
    vec3 up = normalize(p);
    vec4 G[NG];
    surfaceRadiance(uBottomR, 0.0, up, up, G);
    for (int i = 0; i < NG; i++) S[i] += G[i] * T[i];
    return;
  }
  float sinT = length(cross(dir, uSunDir));
  float theta = dot(dir, uSunDir) > 0.0 ? asin(min(1.0, sinT)) : PI;
  float alpha = uSunAngR;
  if (theta < alpha + 0.5 * uPixelAngle) {
    float coverage = clamp((alpha - theta) / uPixelAngle + 0.5, 0.0, 1.0);
    float x = min(theta, alpha * 0.999) / alpha;
    float muP = sqrt(max(0.0, 1.0 - x * x));
    for (int i = 0; i < NG; i++) {
      vec4 a = uLdExp[i];
      S[i] += uSolar[i] / uSunOmega * (a + 2.0) * 0.5 * pow(vec4(muP), a) * T[i] * coverage;
    }
  }
}

void shadeRidge(vec3 dir, int k, float t, bool onFloor, float rim, out vec4 S[NG]) {
  vec4 L[NG];
  vec4 T[NG];
  bool hitGround;
  bool missed;
  float tEnd;
  int steps = max(8, min(uSteps, int(floor(float(uSteps) * 0.4 + 0.5))));
  traceRay(dir, t, true, steps, L, T, hitGround, missed, tEnd);
  vec2 hd = -dir.xz;
  float hl = length(hd);
  hd = hl > 0.0 ? hd / hl : vec2(1.0, 0.0);
  float slope = uRidge[k].z;
  float tilt = onFloor ? PI * 0.5 : slope + rim * (PI * 0.5 - slope) * 0.6;
  vec3 n = vec3(hd.x * cos(tilt), sin(tilt), hd.y * cos(tilt));
  float h = max(0.0, uAltitude);
  vec4 G[NG];
  surfaceRadiance(uBottomR + h, h * (2.0 * uBottomR + h), vec3(0.0, 1.0, 0.0), n, G);
  for (int i = 0; i < NG; i++) S[i] = L[i] + G[i] * T[i];
}

void shadeDirection(vec3 dir, out vec4 Sum[NG]) {
  for (int i = 0; i < NG; i++) Sum[i] = vec4(0.0);
  float elev = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.x, dir.z);
  if (az < 0.0) az += 2.0 * PI;
  float px = max(uPixelAngle, 1e-6);
  float remaining = 1.0;
  vec4 S[NG];

  if (uHillWeight > 0.0) {
    float tFloor = elev < uFloorElevation ? (uFloorDepth + max(0.0, uAltitude)) / sin(-elev) : 1e9;
    for (int k = 0; k < 3; k++) {
      if (remaining <= 1e-6) break;
      float ridge = ridgeElevation(k, az);
      float cov = uHillWeight * clamp((ridge - elev) / px + 0.5, 0.0, 1.0);
      if (cov <= 0.0) continue;
      float tHill = uRidge[k].x / max(0.05, cos(elev));
      if (k == 0) {
        float rise = ridgeHeight(0, az) / uRidge[0].x - tan(elev);
        float eye = max(uFloorDepth, uAltitude);
        if (rise > 0.0) tHill = min(tHill, eye / rise / max(0.05, cos(elev)));
      }
      bool onFloor = tFloor < tHill;
      float rim = clamp(1.0 - (ridge - elev) / uRimAngle, 0.0, 1.0);
      shadeRidge(dir, k, min(tHill, tFloor), onFloor, onFloor ? 0.0 : rim, S);
      float w = remaining * cov;
      for (int i = 0; i < NG; i++) Sum[i] += w * S[i];
      remaining *= 1.0 - cov;
    }
  }

  if (remaining > 1e-6) {
    float R = uBottomR;
    float h0 = max(0.0, uAltitude);
    float horizon = -atan(sqrt(h0 * (2.0 * R + h0)) / R);
    float below = clamp((horizon - elev) / px + 0.5, 0.0, 1.0);
    if (below > 0.0 && below < 1.0) {
      float ce = cos(horizon + 0.5 * px);
      vec3 upDir = vec3(ce * sin(az), sin(horizon + 0.5 * px), ce * cos(az));
      float cd = cos(horizon - 0.5 * px);
      vec3 downDir = vec3(cd * sin(az), sin(horizon - 0.5 * px), cd * cos(az));
      vec4 A[NG];
      shadeOpen(upDir, A);
      shadeOpen(downDir, S);
      for (int i = 0; i < NG; i++) Sum[i] += remaining * ((1.0 - below) * A[i] + below * S[i]);
    } else {
      shadeOpen(dir, S);
      for (int i = 0; i < NG; i++) Sum[i] += remaining * S[i];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Display: XYZ → linear sRGB → exposure → tone map → sRGB (see colour.ts and tonemap.ts)

const mat3 XYZ_TO_SRGB = mat3(XYZ_TO_SRGB_COLS);
const mat3 SRGB_TO_REC2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.088, 0.0433, 0.0113, 0.8956);
const mat3 REC2020_TO_SRGB = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
const mat3 AGX_INSET = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);
const mat3 AGX_OUTSET = mat3(
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) {
  c = AGX_INSET * (SRGB_TO_REC2020 * c);
  c = clamp((log2(max(c, vec3(1e-10))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  c = pow(max(c, vec3(0.0)), vec3(AGX_LOOK_POWER));
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = luma + AGX_LOOK_SATURATION * (c - luma);
  c = AGX_OUTSET * c;
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  c = REC2020_TO_SRGB * c;
  return clamp(c, 0.0, 1.0);
}

vec3 neutral(vec3 c) {
  const float start = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return clamp(c, 0.0, 1.0);
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(c, vec3(newPeak), g), 0.0, 1.0);
}

vec3 srgbEncode(vec3 v) {
  v = clamp(v, 0.0, 1.0);
  return mix(1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, 12.92 * v, vec3(lessThanEqual(v, vec3(0.0031308))));
}

// Interleaved gradient noise (Jimenez 2014), the same dither as cpuRender.ts.
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  vec2 pix = gl_FragCoord.xy - 0.5;
  // Image y grows downward in the CPU renderer; gl_FragCoord grows upward.
  float x = 2.0 * (pix.x + 0.5) / uResolution.x - 1.0;
  float y = 2.0 * (pix.y + 0.5) / uResolution.y - 1.0;
  vec3 dir = normalize(uCamF + x * uTan.x * uCamR + y * uTan.y * uCamU);
  vec4 S[NG];
  shadeDirection(dir, S);
  vec3 xyz = vec3(0.0);
  for (int i = 0; i < NG; i++) {
    xyz += vec3(dot(uCmfX[i], S[i]), dot(uCmfY[i], S[i]), dot(uCmfZ[i], S[i]));
  }
  vec3 rgb = XYZ_TO_SRGB * xyz * uExposure;
  vec3 mapped = uToneMap == 1 ? neutral(rgb) : agx(rgb);
  vec3 enc = srgbEncode(mapped);
  float iy = uResolution.y - 1.0 - pix.y;
  enc += (ign(vec2(pix.x, iy)) - 0.5) / 255.0;
  outColor = vec4(enc, 1.0);
}
