import {ID} from './model.mjs';
import {isPrimaryGM, requirePrimaryGM, withAction} from './assistant-core.mjs';
import {localizeHTML, t} from './i18n.mjs';

const handlers = new Map();
const boundButtons = new WeakSet();
const pendingCards = new Map();
let registered = false;

function cardIdentity(message) {
  const card = message.flags?.[ID]?.chatCard;
  return typeof card?.domain === 'string' && typeof card?.id === 'string' ? card : null;
}

/** Refresh one GM-only card on meaningful workflow transitions. */
export function upsertGMCard({domain, id, content}) {
  if (typeof domain !== 'string' || !domain || typeof id !== 'string' || !id || typeof content !== 'string') {
    return Promise.reject(new Error(t('Common.InvalidDomain')));
  }
  return withAction(`chat-card:${JSON.stringify([domain, id])}`, async () => {
    const whisper = Array.from(game.users ?? []).filter(user => user.isGM).map(user => user.id).sort();
    if (!whisper.length) throw new Error(t('Common.NoGM'));
    const message = Array.from(game.messages ?? []).find(message => {
      const card = cardIdentity(message);
      return card?.domain === domain && card.id === id;
    });
    if (message) {
      const recipients = Array.from(message.whisper ?? []).map(user => typeof user === 'string' ? user : user.id).sort();
      if (message.content === content && JSON.stringify(recipients) === JSON.stringify(whisper)) return message;
      requirePrimaryGM();
      return message.update({content, whisper});
    }
    requirePrimaryGM();
    return ChatMessage.create({
      content, whisper, flavor:localizeHTML('Common.Title'),
      flags:{[ID]:{chatCard:{domain, id}}},
      style:globalThis.CONST?.CHAT_MESSAGE_STYLES?.OTHER ?? 0
    });
  });
}

export function registerCardActions(domain, handler) {
  if (typeof domain !== 'string' || !domain || typeof handler !== 'function') throw new TypeError('Invalid chat card handler');
  handlers.set(domain, handler);
}

function renderCard(message, element) {
  const card = cardIdentity(message);
  if (!card || !handlers.has(card.domain)) return;
  const root = element?.[0] ?? element;
  const buttons = Array.from(root?.querySelectorAll?.('[data-bob-card-action]') ?? []);
  const key = JSON.stringify([card.domain, card.id]);
  for (const button of buttons) {
    const pending = pendingCards.get(key);
    if (pending && !pending.has(button)) pending.set(button, button.disabled);
    if (!isPrimaryGM() || pending) button.disabled = true;
    if (boundButtons.has(button)) continue;
    boundButtons.add(button);
    button.addEventListener('click', async event => {
      event.preventDefault();
      if (button.disabled || !isPrimaryGM() || pendingCards.has(key)) return;
      const disabled = new Map(buttons.map(button => [button, button.disabled]));
      pendingCards.set(key, disabled);
      buttons.forEach(button => { button.disabled = true; });
      try {
        requirePrimaryGM();
        await handlers.get(card.domain)({
          action:button.dataset.bobCardAction, id:card.id,
          actorId:button.dataset.actor, message, button
        });
      } catch (error) {
        globalThis.ui?.notifications?.error?.(error.message ?? t('Chat.ActionFailed'));
      } finally {
        pendingCards.delete(key);
        for (const [button, wasDisabled] of disabled) button.disabled = !isPrimaryGM() || wasDisabled;
      }
    });
  }
}

export function registerChatCards() {
  if (registered) return;
  registered = true;
  Hooks.on('renderChatMessageHTML', renderCard);
}
