/** No Foundry globals: identity, preview and recoverable soulheart transactions. */
import {t} from './i18n.mjs';
export const SOULHEART_GRADES = Object.freeze({
  ordinary:{rank:0,hp:1,day:6,night:3,slug:'soulheart',source:'Compendium.pf2e.equipment-srd.Item.8WxFFZm6OcBCCARR',label:'Soulheart.GradeOrdinary'},
  greater:{rank:1,hp:2,day:12,night:6,slug:'soulheart-greater',source:'Compendium.pf2e.equipment-srd.Item.5nNs3OFkRXH8yU1D',label:'Soulheart.GradeGreater'},
  major:{rank:2,hp:3,day:18,night:9,slug:'soulheart-major',source:'Compendium.pf2e.equipment-srd.Item.05h3LWflr74iJiVg',label:'Soulheart.GradeMajor'}
});
const clone = value => structuredClone(value);
const values = collection => Array.from(collection?.values?.() ?? collection ?? []);
export function soulheartGrade(item,binding) {
  if(!item || item.type!=='equipment') return null;
  const source=item.sourceId ?? item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
  if(['soulheart-pure','soulheart-angelic'].includes(item.system?.slug)||['Compendium.pf2e.equipment-srd.Item.klQlruwrLO0xvPjl','Compendium.pf2e.equipment-srd.Item.Y10KCgi8mOL2iAkS'].includes(source))return null;
  const known=Object.entries(SOULHEART_GRADES).find(([,grade])=>grade.source===source)?.[0]??Object.entries(SOULHEART_GRADES).find(([,grade])=>grade.slug===item.system?.slug)?.[0];
  return known ?? (Object.hasOwn(SOULHEART_GRADES,binding??'') ? binding : null);
}
export function phantomRank(actor) {
  const matches=values(actor?.items).flatMap(item=>(item._source?.system?.rules ?? item.system?.rules ?? []).filter(rule=>rule.key==='RollOption' && rule.option==='support-rank' && rule.toggleable && ['1','2','3'].every(value=>rule.suboptions?.some(option=>option.value===value))).map(rule=>({item,rule})));
  if(matches.length!==1) throw new Error(t('Soulheart.ErrorPhantomSwitch'));
  const {item,rule}=matches[0],rank=rule.value===false?0:Number(rule.selection);
  if(!Number.isInteger(rank)||rank<0||rank>3) throw new Error(t('Soulheart.ErrorPhantomRank'));
  return {rank,itemId:item.id,domain:rule.domain??'all',option:'support-rank'};
}
function actualItem(item,binding) {
  const grade=soulheartGrade(item,binding),quantity=Number(item?.system?.quantity);
  if(!grade) throw new Error(t('Soulheart.ErrorItemUnrecognized'));
  if(!Number.isInteger(quantity)||quantity<1) throw new Error(t('Soulheart.ErrorQuantity'));
  return {grade,quantity};
}
export function planUpgrade({id,holderId,item,phantom,beneficiaries,state={},time,binding}) {
  const {grade,quantity}=actualItem(item,binding),rule=SOULHEART_GRADES[grade],rank=phantomRank(phantom);
  if(rule.rank!==rank.rank) throw new Error(t('Soulheart.ErrorRequiredRank',{required:rule.rank,current:rank.rank}));
  if(!id||!holderId||!beneficiaries?.length) throw new Error(t('Soulheart.ErrorBeneficiaries'));
  const unique=[...new Map(beneficiaries.map(actor=>[actor.id,actor])).values()];
  const baseline=unique.map(actor=>({id:actor.id,effectId:actor.effect?.id??null,before:Number(actor.effect?.value??0)}));
  if(baseline.some(pc=>!Number.isInteger(pc.before)||pc.before<0)) throw new Error(t('Soulheart.ErrorHPBaseline'));
  const totalBefore=Math.max(Number(state.total??0),...baseline.map(pc=>pc.before));
  return {id,kind:'upgrade',status:'preview',createdAt:time,holderId,itemId:item.id,itemUuid:item.uuid,grade,binding:binding??null,
    quantityBefore:quantity,quantityAfter:quantity-1,phantomId:phantom.id,rankItemId:rank.itemId,rankDomain:rank.domain,
    rankBefore:rank.rank,rankAfter:rank.rank+1,beneficiaries:baseline,totalBefore,totalAfter:totalBefore+rule.hp,
    ledgerBefore:Number(state.total??0),previousCompleted:state.lastCompleted??null,steps:{}};
}
export function planHPSync({id,beneficiaries,state={},time,baseline}) {
  if(!beneficiaries?.length)throw new Error(t('Soulheart.ErrorBeneficiaries'));
  const targets=[...new Map(beneficiaries.map(pc=>[pc.id,pc])).values()].map(pc=>({id:pc.id,effectId:pc.effect?.id??null,before:Number(pc.effect?.value??0)}));
  const minimum=Math.max(Number(state.total??0),...targets.map(pc=>pc.before));
  baseline=baseline??minimum;
  if(!Number.isInteger(baseline)||baseline<minimum)throw new Error(t('Soulheart.ErrorBaselineDecrease'));
  return {id,kind:'sync',status:'preview',createdAt:time,beneficiaries:targets,totalBefore:minimum,totalAfter:baseline,ledgerBefore:Number(state.total??0),previousCompleted:state.lastCompleted??null,steps:{}};
}
const stepsFor = op => [...(op.kind==='sync'?[]:['quantity','rank']),...op.beneficiaries.map(pc=>`hp:${pc.id}`)];
function ensureAvailable(state,id) {
  if(Object.values(state.operations??{}).some(op=>op.id!==id && ['pending','correcting'].includes(op.status))) throw new Error(t('Soulheart.ErrorPending'));
}
async function recordFailure(port,id,error) {
  await port.save(state=>{state.operations[id].error=String(error.message??error);});
}
export async function runUpgrade(port,proposal,confirmed=false) {
  if(!confirmed) return null;
  let state=port.read(),op=state.operations?.[proposal.id];
  ensureAvailable(state,proposal.id);
  if(op?.status==='complete'||op?.status==='corrected') return op;
  if(op?.status==='correcting') throw new Error(t('Soulheart.ErrorCorrecting'));
  if(!op) {
    await port.preflight(proposal);
    await port.save(state=>{ensureAvailable(state,proposal.id);state.operations??={};state.operations[proposal.id]={...clone(proposal),status:'pending'};});
  }
  try {
    for(const step of stepsFor(port.read().operations[proposal.id])) {
      op=port.read().operations[proposal.id];
      // Applied steps are not replayed. An unacknowledged document write is reconciled by the port.
      if(op.steps[step]) continue;
      await port.apply(op,step,false);
      await port.save(state=>{state.operations[op.id].steps[step]=true;});
    }
    await port.save(state=>{const current=state.operations[proposal.id];current.status='complete';delete current.error;state.total=current.totalAfter;state.lastCompleted=current.id;});
  } catch(error) {await recordFailure(port,proposal.id,error);throw error;}
  return port.read().operations[proposal.id];
}
export async function correctUpgrade(port,id) {
  let state=port.read(),op=state.operations?.[id];
  if(op?.status==='corrected') return op;
  if(!op||!['complete','correcting'].includes(op.status)) throw new Error(t('Soulheart.ErrorCompleteFirst'));
  ensureAvailable(state,id);
  if(state.lastCompleted!==id) throw new Error(t('Soulheart.ErrorLaterAward'));
  if(op.status!=='correcting') {
    await port.checkCorrection(op);
    await port.save(state=>{state.operations[id].status='correcting';state.operations[id].undoSteps={};});
  }
  try {
    for(const step of stepsFor(op).reverse()) {
      op=port.read().operations[id];if(op.undoSteps[step]) continue;
      await port.apply(op,step,true);
      await port.save(state=>{state.operations[id].undoSteps[step]=true;});
    }
    await port.save(state=>{const current=state.operations[id];current.status='corrected';delete current.error;state.total=current.ledgerBefore;state.lastCompleted=current.previousCompleted;});
  } catch(error) {await recordFailure(port,id,error);throw error;}
  return port.read().operations[id];
}
export function planLife({id,holderId,item,phase,time,seconds,lastUse,binding}) {
  const {grade}=actualItem(item,binding);
  if(!['day','night'].includes(phase)||!Number.isFinite(time)||!Number.isFinite(seconds)) throw new Error(t('Soulheart.ErrorClock'));
  if(lastUse && time<lastUse.resetAt) throw new Error(t('Soulheart.ErrorDailyUsed'));
  return {id,kind:'life',status:'preview',holderId,itemId:item.id,itemUuid:item.uuid,grade,binding:binding??null,createdAt:time,temporaryHP:SOULHEART_GRADES[grade][phase],phase,
    expiresAt:time+28800,resetAt:time+86400-((seconds%86400+86400)%86400),quantityBefore:Number(item.system.quantity),steps:{}};
}
export async function runLife(port,proposal,confirmed=false) {
  if(!confirmed)return null;
  let state=port.read(),op=state.operations?.[proposal.id];ensureAvailable(state,proposal.id);
  if(op?.status==='complete')return op;
  if(!op) {
    await port.preflightLife(proposal);
    await port.save(state=>{ensureAvailable(state,proposal.id);state.operations??={};state.operations[proposal.id]={...clone(proposal),status:'pending'};});
  }
  try {
    for(const step of ['daily','effect']) {
      op=port.read().operations[proposal.id];if(op.steps[step])continue;
      await port.applyLife(op,step);
      await port.save(state=>{state.operations[op.id].steps[step]=true;});
    }
    await port.save(state=>{state.operations[proposal.id].status='complete';delete state.operations[proposal.id].error;});
  } catch(error) {await recordFailure(port,proposal.id,error);throw error;}
  return port.read().operations[proposal.id];
}
