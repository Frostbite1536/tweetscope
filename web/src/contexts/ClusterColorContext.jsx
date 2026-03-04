import { createContext, useContext } from 'react';
import PropTypes from 'prop-types';

const ClusterColorContext = createContext(null);

export function ClusterColorProvider({ children, colorMap }) {
  return (
    <ClusterColorContext.Provider value={colorMap ?? null}>
      {children}
    </ClusterColorContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useClusterColorMap() {
  return useContext(ClusterColorContext);
}

ClusterColorProvider.propTypes = {
  children: PropTypes.node,
  colorMap: PropTypes.instanceOf(Map),
};
