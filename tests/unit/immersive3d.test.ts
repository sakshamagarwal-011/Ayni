import { describe, expect, it } from 'vitest';
import { canUseImmersive3D } from '../../src/map/style';

describe('canUseImmersive3D', () => {
  it('is supported when WebGL + buildings + vector style + enabled', () => {
    const result = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable: 'yes',
      usingRasterFallback: false,
      map3dEnabled: true,
    });
    expect(result.supported).toBe(true);
  });

  it('is unsupported without WebGL', () => {
    const result = canUseImmersive3D({
      webglSupported: false,
      buildingsAvailable: 'yes',
      usingRasterFallback: false,
      map3dEnabled: true,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebGL/);
  });

  it('is unsupported on the raster fallback', () => {
    const result = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable: 'yes',
      usingRasterFallback: true,
      map3dEnabled: true,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/raster/);
  });

  it('is unsupported when the style has no buildings', () => {
    const result = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable: 'no',
      usingRasterFallback: false,
      map3dEnabled: true,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/not available/);
  });

  it('is pending while building availability is unknown', () => {
    const result = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable: 'unknown',
      usingRasterFallback: false,
      map3dEnabled: true,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/Checking/);
  });

  it('is unsupported when 3D is disabled in settings', () => {
    const result = canUseImmersive3D({
      webglSupported: true,
      buildingsAvailable: 'yes',
      usingRasterFallback: false,
      map3dEnabled: false,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/disabled/);
  });
});
