import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import styles from './SubNav.module.css';

const SubNav = ({ dataset, scope, scopes, onScopeChange }) => {
  if (!dataset) {
    return (
      <div className={styles.subHeaderContainer}>
        <div className={styles.contextBar}>
          <div className={styles.scopeBadge}>
            <span className={styles.scopeValue}>Loading...</span>
          </div>
          <span className={`${styles.actionButton} ${styles.disabledAction}`}>
            All Maps
          </span>
        </div>
      </div>
    );
  }

  const hasMultipleScopes = Array.isArray(scopes) && scopes.length > 1;

  return (
    <div className={styles.subHeaderContainer}>
      <div className={styles.contextBar}>
        <div className={styles.scopeBadge}>
          <span className={styles.scopeValue}>{dataset?.id || '-'}</span>
        </div>

        {hasMultipleScopes && onScopeChange && (
          <select
            className={styles.scopeSelect}
            value={scope?.id || ''}
            onChange={onScopeChange}
          >
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.id}
              </option>
            ))}
          </select>
        )}

        <Link to="/" className={styles.actionButton}>
          All Maps
        </Link>
      </div>
    </div>
  );
};

SubNav.propTypes = {
  dataset: PropTypes.object,
  scope: PropTypes.object,
  scopes: PropTypes.array,
  onScopeChange: PropTypes.func,
};

export default SubNav;
