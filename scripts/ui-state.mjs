import {t} from './i18n.mjs';
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export class RuleDraft {
  constructor(config) { this.base=structuredClone(config); this.value=structuredClone(config); }
  set(key,value) { this.value[key]=value; }
  get changed() { return Object.keys(this.value).filter(key => !equal(this.value[key],this.base[key])); }
  get dirty() { return this.changed.length > 0; }
  async save(read,write) {
    const [start,end]=this.value.rainBreak ?? [];
    if (![start,end].every(Number.isInteger) || start<0 || end>1440 || end-start<60 || end-start>120) {
      throw new Error(t('UI.InvalidRainBreak'));
    }
    const submitted=structuredClone(this.value), latest=read(), changed=this.changed;
    if(changed.some(key => !equal(latest[key],this.base[key]) && !equal(latest[key],this.value[key]))) {
      throw new Error(t('UI.DraftConflict'));
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
  let target=({perception:t('Rule.Perception'),'ranged-strike-attack-roll':t('Rule.RangedStrike'),initiative:t('Rule.Initiative'),'saving-throw':t('Rule.Save'),'attack-roll':t('Rule.Attack')})[rule.selector] ?? t('Rule.Note');
  let condition='';
  if(predicate.includes('item:trait:holy')) {target=t('Rule.HolySave');condition=t('Rule.HolyCondition');}
  if(predicate.includes('item:trait:fear')) {target=t('Rule.FearSave');condition=t('Rule.FearCondition');}
  if(predicate.includes('item:trait:visual')) condition=t('Rule.VisualCondition');
  const fog=rule.key==='Note'&&rule.slug==='bob-fog';
  if(rule.key==='Note') condition=fog?t('Rule.FogText'):rule.text ?? t('Rule.CheckCondition');
  return {target,value:typeof rule.value==='number'?`${rule.value>0?'+':rule.value<0?'−':''}${Math.abs(rule.value)}`:t('Rule.Hint'),
    source:fog?t('Rule.Fog'):rule.label ?? rule.title ?? '',condition,conditional:Boolean(predicate.length || rule.key==='Note')};
}
