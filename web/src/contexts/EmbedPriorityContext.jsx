import { createContext, useContext } from 'react';
import { EMBED_PRIORITY } from '../lib/embedScheduler';

// Lightweight context for embed priority so that carousel columns can set
// priority for all descendant TwitterEmbed components without prop drilling.
const EmbedPriorityContext = createContext(EMBED_PRIORITY.FAR);

export const EmbedPriorityProvider = EmbedPriorityContext.Provider;

export function useEmbedPriority() {
  return useContext(EmbedPriorityContext);
}
