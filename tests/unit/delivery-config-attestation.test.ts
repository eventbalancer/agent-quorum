import { describe, expect, it } from 'vitest';
import { digest } from '../../src/delivery/contract.js';
import {
  codexConfigurationDigest,
  readCodexConfigurationDigest,
} from '../../src/delivery/config-attestation.js';

describe('effective Codex configuration attestation', () => {
  it('hashes configuration and managed layer content independent of key serialization order', () => {
    const first = {
      config: { permissions: { read: 'deny', network: false }, features: {} },
      layers: [
        {
          name: { type: 'system', file: '/etc/config' },
          version: 'v1',
          config: { policy: 'deny' },
        },
      ],
    };
    const second = {
      layers: [
        {
          version: 'v1',
          config: { policy: 'deny' },
          name: { file: '/etc/config', type: 'system' },
        },
      ],
      config: { features: {}, permissions: { network: false, read: 'deny' } },
    };
    expect(codexConfigurationDigest(first)).toBe(codexConfigurationDigest(second));
    expect(
      codexConfigurationDigest({ ...first, config: { permissions: { read: 'allow' } } }),
    ).not.toBe(codexConfigurationDigest(first));
    expect(() => codexConfigurationDigest({ config: {}, layers: null })).toThrow(
      'effective-codex-configuration-unavailable',
    );
  });

  it('uses an ordered handshake and closes the bounded metadata process without provider work', async () => {
    const script = `let b=''; process.stdin.on('data', c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture-provider-version'}})+'\\n')}else if(m.method==='config/read'){process.stdout.write(JSON.stringify({id:m.id,result:{config:{permissions:'deny'},layers:[]}})+'\\n')}}});`;
    const actual = await readCodexConfigurationDigest(
      process.cwd(),
      { deadlineEpochMs: Date.now() + 3000 },
      [],
      { bin: process.execPath, args: ['-e', script] },
    );
    expect(actual).toBe(
      digest({
        userAgent: 'fixture-provider-version',
        configuration: codexConfigurationDigest({ config: { permissions: 'deny' }, layers: [] }),
      }),
    );
  });

  it('fails closed on an unsupported config-read response', async () => {
    const script = `process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:2,result:{config:{}}})+'\\n'));`;
    await expect(
      readCodexConfigurationDigest(process.cwd(), { deadlineEpochMs: Date.now() + 3000 }, [], {
        bin: process.execPath,
        args: ['-e', script],
      }),
    ).rejects.toThrow('effective-codex-configuration-unavailable');
  });
});
