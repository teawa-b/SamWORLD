import { describe, expect, it } from 'vitest';
import { pickModels } from '../src/meta/models.js';

const cur = { museModel: 'muse-spark-1.3', escalationModel: 'muse-wonder-1.0', samModel: 'sam-3.1', imageModel: 'muse-image-1.0' };

describe('model resolution', () => {
  it('keeps configured IDs that exist', () => {
    expect(pickModels(['muse-spark-1.3', 'muse-wonder-1.0', 'sam-3.1', 'muse-image-1.0'], cur).changed).toEqual([]);
  });
  it('switches to the newest model of the same family', () => {
    const { chosen, changed } = pickModels(['muse-spark-1.4', 'muse-spark-1.3-contributor', 'muse-spark-1.2', 'sam-3', 'muse-image-1.1'], cur);
    expect(chosen.museModel).toBe('muse-spark-1.4');
    expect(chosen.samModel).toBe('sam-3');
    expect(chosen.imageModel).toBe('muse-image-1.1');
    expect(chosen.escalationModel).toBe('muse-spark-1.4');
    expect(changed).toHaveLength(4);
  });
  it('prefers the plain ID over a variant of the same version', () => {
    expect(pickModels(['muse-spark-1.3-contributor', 'muse-spark-1.3-preview', 'muse-spark-1.3x'], { ...cur, museModel: 'x' }).chosen.museModel).toBe('muse-spark-1.3x');
  });
});
