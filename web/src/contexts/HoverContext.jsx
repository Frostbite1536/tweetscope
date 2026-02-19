import { createContext, useContext } from 'react';

// Lightweight context for hover state so that only the 2 affected TweetCards
// rerender on hover (previously-highlighted + newly-highlighted) instead of
// cascading through FeedCarousel → FeedColumn → all TweetCards (C5 fix).
const HoverContext = createContext(null);

export function HoverProvider({ children, hoveredIndex }) {
  return (
    <HoverContext.Provider value={hoveredIndex}>
      {children}
    </HoverContext.Provider>
  );
}

export function useHoveredIndex() {
  return useContext(HoverContext);
}
