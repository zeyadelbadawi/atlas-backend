/**
 * B0-OPS-05 — the restore-drill function library is shipped in this
 * repository (runbook Appendix A, verbatim) and delivered by the deploy
 * action to /opt/atlas/restore-drill/restore-drill-lib.sh. The operator
 * checks the same SHA-256 on the VPS before sourcing it (runbook §5.0).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const LIB = join(ROOT, 'deploy', 'restore-drill', 'restore-drill-lib.sh');
/** Runbook v2.2, Appendix A. */
const RUNBOOK_SHA256 = '48d7d69b71cedd54d4ee07a75114fb1a34f5c9bd7b6fe6187e409ee37b3321f9';

describe('restore-drill library (B0-OPS-05)', () => {
  it('is byte-identical to the runbook Appendix A (SHA-256)', () => {
    const hash = createHash('sha256').update(readFileSync(LIB)).digest('hex');
    expect(hash).toBe(RUNBOOK_SHA256);
  });

  it('is a library to source, not a program: no execute bit', () => {
    expect(statSync(LIB).mode & 0o111).toBe(0);
  });

  it('is delivered by the deploy action as 0600 in a 0700 directory, and never executed', () => {
    const action = readFileSync(
      join(ROOT, '.github', 'actions', 'vps-deploy', 'action.yml'),
      'utf8',
    );
    expect(action).toContain('install -d -m 0700 /opt/atlas/restore-drill');
    expect(action).toContain('deploy/restore-drill/restore-drill-lib.sh');
    expect(action).toContain(
      'chmod 0600 /opt/atlas/restore-drill/.restore-drill-lib.sh.new',
    );
    // Nothing runs it: no `bash`/`sh`/`source`/`.` in front of the path.
    expect(action).not.toMatch(
      /(?:\bbash|\bsh|\bsource|(?:^|[;&|]\s*)\.)\s+\S*restore-drill-lib\.sh/m,
    );
    const deployScript = readFileSync(join(ROOT, 'deploy', 'deploy.sh'), 'utf8');
    expect(deployScript).not.toContain('restore-drill-lib');
  });
});
