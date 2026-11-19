// Required named fields used by the live damage and scoreboard readers.
const fieldsByRole = {
  batch: ['body', 'lengths'], combat: ['kind', 'schema', 'body'], heroStats: ['vector', 'counter'],
  heroSpawn: ['model', 'id'], display: ['sourceId', 'targetId', 'amount', 'typeCode'], marker: ['time', 'kind'],
  replication: ['time', 'vector'], recap: ['duration', 'outgoing'], entry: ['details'],
  detail: ['physical', 'magic', 'true'], turret: ['name', 'counter', 'destroyedTime', 'stateTime', 'destroyed']
};

function validFixedReader(reader, named) {
  const { size, order } = reader;
  if (!Number.isInteger(size) || size < 1 || size > 128) return false;
  if (!named) return true;
  if (size > 6 || !(reader.table || reader.tables?.length === size)) return false;
  if (size === 1) return true;
  return Array.isArray(order) && order.length === size && new Set(order).size === size
    && order.every(n => Number.isInteger(n) && n >= 0 && n < size);
}

export function validateLiveProfile(profile, file) {
  const exact = /^\d+\.\d+\.\d+\.\d+$/;
  if (!exact.test(profile.build) || file !== profile.build + '.json' || !/^[a-f0-9]{64}$/.test(profile.sha256)
      || typeof profile.secondaryTimestamp !== 'boolean' || profile.partial) throw new Error('Invalid build profile');
  const patch = profile.build.split('.').slice(0, 2).join('.') + '.';
  if (profile.hotfixBuilds !== undefined && (!Array.isArray(profile.hotfixBuilds)
      || profile.hotfixBuilds.some(v => typeof v !== 'string' || !exact.test(v) || !v.startsWith(patch)))) {
    throw new Error('Invalid hotfix build');
  }
  const modes = profile.modes ?? [];
  if (!Array.isArray(modes) || modes.some(m => typeof m.mayhem !== 'boolean' || !Array.isArray(m.queues)
      || !m.queues.length || !m.queues.every(Number.isSafeInteger) || !Number.isSafeInteger(m.observerDelaySeconds)
      || m.observerDelaySeconds < 0 || m.observerDelaySeconds > 900)) throw new Error('Invalid scoreboard modes');
  const layouts = Object.keys(fieldsByRole).filter(role => role !== 'turret' || modes.some(m => !m.mayhem)
    || Object.hasOwn(profile.ids, 'turret'));
  const roles = [...layouts.filter(role => role !== 'entry' && role !== 'detail'), 'recapOwner'];
  const ids = [...roles, 'ownerAction'];
  if (Object.keys(profile.ids).some(role => !ids.includes(role))) throw new Error('Unexpected packet role');
  for (const role of ids) {
    const id = profile.ids[role];
    if (!Number.isInteger(id) || id < 0 || id > 1530) throw new Error('Missing or invalid packet ID for ' + role);
  }
  if (new Set(roles.map(role => profile.ids[role])).size !== roles.length) throw new Error('Duplicate incoming packet IDs');
  for (const role of layouts) {
    const fields = profile.layouts[role]?.fields;
    if (!Array.isArray(fields) || fieldsByRole[role].some(name => fields.filter(f => f.name === name).length !== 1)) {
      throw new Error('Missing or duplicate fields for ' + role);
    }
  }
  for (const [role, layout] of Object.entries(profile.layouts)) {
    if (!layouts.includes(role) || !Number.isInteger(layout.flagBytes) || layout.flagBytes < 1 || layout.flagBytes > 16) {
      throw new Error('Invalid layout for ' + role);
    }
    for (const field of layout.fields) {
      if (field.name !== undefined && !(fieldsByRole[role].includes(field.name)
          || (role === 'display' && ['hash', 'resultCode', 'displayCode'].includes(field.name)))) {
        throw new Error('Unexpected named field in ' + role);
      }
      const [start, width] = field.bits;
      if (!Number.isInteger(start) || !Number.isInteger(width) || start < 0 || width < 1 || width > 3
          || start + width > layout.flagBytes * 8 || field.cases.length !== 2 ** width || !Array.isArray(field.readers)
          || field.cases.some(c => c && typeof c === 'object' && (!Number.isInteger(c.read) || !field.readers[c.read]))) {
        throw new Error('Invalid selector in ' + role);
      }
      for (const reader of field.readers) {
        if ((reader.kind === 'varints' || reader.kind === 'varint') && (![1, 2, 4].includes(reader.width) || !reader.table)) {
          throw new Error('Invalid integer reader in ' + role);
        }
        if (reader.kind === 'fixed' && !validFixedReader(reader, field.name !== undefined)) {
          throw new Error('Invalid fixed-width reader in ' + role);
        }
        if (['struct', 'structs'].includes(reader.kind)
            && !((role === 'recap' && reader.layout === 'entry') || (role === 'entry' && reader.layout === 'detail'))) {
          throw new Error('Invalid nested record in ' + role);
        }
      }
    }
  }
}
