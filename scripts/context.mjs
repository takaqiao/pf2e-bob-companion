const EXPOSURES = new Set(['unknown', 'outdoors', 'indoors', 'rain-shelter', 'wind-shelter']);
const ROLES = new Set(['auto', 'pc', 'enemy', 'ally', 'ignore']);
const PERCEPTIONS = new Set(['auto', 'visual', 'nonvisual']);
const choose = (values, allowed, fallback) => values.find(value => allowed.has(value)) ?? fallback;

export function endStorm(environment) {
  return {...environment, perception: 0, ranged: 0, fog: false, raining: false, notes: [
    '剧情风暴已停止：停用风雨、浓雾、周期雷击；残留积水与寒冷由 GM 按剧情裁定。',
    ...(environment.notes ?? []).filter(note => note.includes('最后一次'))
  ]};
}

/** Called only after the parent item is recognized as an official Skies Above effect. */
export function isManagedSkyRule(rule) {
  const selectors = rule?.selector instanceof Set ? [...rule.selector] : Array.isArray(rule?.selector) ? rule.selector : [rule?.selector];
  if (rule?.key === 'FlatModifier') return selectors.length > 0 && selectors.every(selector =>
    ['perception', 'ranged-strike-attack-roll'].includes(selector));
  if (rule?.key !== 'Note' || selectors.length !== 1 || selectors[0] !== 'attack-roll') return false;
  return Array.isArray(rule.predicate) && rule.predicate.some(statement =>
    Array.isArray(statement?.gte) && statement.gte[0] === 'target:distance' && statement.gte[1] === 50);
}
export function shouldManageWeather({enabled, weather, exposure, stormEnded}) {
  return Boolean(enabled && weather && (stormEnded || (EXPOSURES.has(exposure) && exposure !== 'unknown')));
}

/** Pure scene/token scope resolution. Inputs deliberately contain no Actor getters. */
export function resolveScope({isToken = false, tokenId = null, tokens = [], scenes = [], activeSceneId = null,
  actorFlags = {}, mainSceneId = null} = {}) {
  const selected = isToken ? tokens.filter(token => token.id === tokenId)
    : tokens.filter(token => token.actorLink && token.sceneId === activeSceneId);
  const sceneId = selected[0]?.sceneId ?? (isToken ? null : actorFlags.sceneId) ?? null;
  const result = {enabled: false, sceneId, exposure: 'unknown', perception: 'auto', roleOverride: 'auto',
    dispositions: selected.map(token => token.disposition), tokenIds: selected.map(token => token.id), warnings: []};
  if (!sceneId) return {...result, reason: '没有适用场景中的 token；需为角色明确绑定场景。'};
  const scene = scenes.find(scene => scene.id === sceneId);
  if (!scene) return {...result, reason: '绑定场景不存在。'};
  if (scene.scope === 'exclude') return {...result, reason: '此场景已排除。'};
  if (scene.scope !== 'include' && scene.id !== mainSceneId) return {...result, reason: '此场景尚未确认适用 BoB。'};

  function resolveToken(token = {}) {
    const regionExposures = [...new Set((token.regions ?? []).map(region => region.exposure).filter(value => EXPOSURES.has(value)))];
    let exposure = choose([token.exposure], EXPOSURES, null);
    if (exposure === null && regionExposures.length > 1) {
      exposure = 'unknown';
      result.warnings.push('重叠区域的暴露设置冲突，请明确 token 暴露条件。');
    }
    exposure ??= choose([regionExposures[0], actorFlags.exposure, scene.exposure], EXPOSURES, 'unknown');
    return {exposure, perception: choose([token.perception, actorFlags.perception], PERCEPTIONS, 'auto'),
      roleOverride: choose([token.role, actorFlags.role], ROLES, 'auto')};
  }
  const contexts = (selected.length ? selected : [{}]).map(resolveToken);
  for (const key of ['exposure', 'perception', 'roleOverride']) {
    if (new Set(contexts.map(context => context[key])).size > 1) return {...result, reason: '同一 linked 角色的多个 token 设置冲突，请统一设置。'};
    result[key] = contexts[0][key];
  }
  if (result.roleOverride === 'auto' && new Set(result.dispositions).size > 1) {
    return {...result, reason: '同一 linked 角色的 token 阵营显示冲突，请指定角色身份。'};
  }
  if (result.exposure === 'unknown') result.warnings.push('天气暴露条件未知；保留现有手动天气效果。');
  return {...result, enabled: true, reason: result.warnings.join(' ')};
}
