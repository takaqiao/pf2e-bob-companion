const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export class RuleDraft {
  constructor(config) { this.base=structuredClone(config); this.value=structuredClone(config); }
  set(key,value) { this.value[key]=value; }
  get changed() { return Object.keys(this.value).filter(key => !equal(this.value[key],this.base[key])); }
  get dirty() { return this.changed.length > 0; }
  async save(read,write) {
    const [start,end]=this.value.rainBreak ?? [];
    if (![start,end].every(Number.isInteger) || start<0 || end>1440 || end-start<60 || end-start>120) {
      throw new Error('第六章停雨时段须在同一天，持续1～2小时。请修正后保存。');
    }
    const submitted=structuredClone(this.value), latest=read(), changed=this.changed;
    if(changed.some(key => !equal(latest[key],this.base[key]) && !equal(latest[key],this.value[key]))) {
      throw new Error('其他 GM 已修改同一设置。草稿仍保留；请先记录草稿，再载入已保存设置。');
    }
    const result={...latest,...Object.fromEntries(changed.map(key=>[key,this.value[key]]))};
    await write(result);
    const newer=Object.fromEntries(Object.keys(this.value).filter(key=>!equal(this.value[key],submitted[key])).map(key=>[key,this.value[key]]));
    this.base=structuredClone(result);this.value=structuredClone({...result,...newer});
    return result;
  }
}

export function describeRule(rule) {
  const predicate=rule.predicate ?? [];
  let target=({perception:'察觉','ranged-strike-attack-roll':'远程打击',initiative:'先攻','saving-throw':'豁免','attack-roll':'攻击检定'})[rule.selector] ?? '规则提示';
  let condition='';
  if(predicate.includes('item:trait:holy')) {target='圣洁豁免';condition='仅对抗带圣洁特征的效果';}
  if(predicate.includes('item:trait:fear')) {target='恐惧豁免';condition='仅对抗带恐惧特征的效果';}
  if(predicate.includes('item:trait:visual')) condition='仅视觉检定；普通察觉需指定视觉方式';
  if(rule.key==='Note') condition=rule.text ?? '按检定条件判断';
  return {target,value:typeof rule.value==='number'?`${rule.value>0?'+':rule.value<0?'−':''}${Math.abs(rule.value)}`:'提示',
    source:rule.label ?? rule.title ?? '',condition,conditional:Boolean(predicate.length || rule.key==='Note')};
}
