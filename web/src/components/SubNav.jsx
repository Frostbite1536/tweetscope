import { Link } from 'react-router-dom';
import { ChevronsLeft, ChevronDown, House } from 'lucide-react';
import PropTypes from 'prop-types';
import styles from './SubNav.module.css';

const SubNav = ({ dataset, scope, scopes, onScopeChange, onBack }) => {
  if (!dataset) {
    return (
      <div className={styles.subHeaderContainer}>
        <div className={styles.contextBar}>
          <div className={styles.scopeBadge}>
            <span className={styles.scopeValue}>Loading...</span>
          </div>
          <span
            className={`${styles.actionButton} ${styles.homeButton} ${styles.disabledAction}`}
            aria-label="All maps"
            title="All maps"
          >
            <House size={14} />
          </span>
        </div>
      </div>
    );
  }

  const hasMultipleScopes = Array.isArray(scopes) && scopes.length > 1;

  return (
    <div className={styles.subHeaderContainer}>
      <div className={styles.contextBar}>
        <Link to="/" className={`${styles.actionButton} ${styles.homeButton}`} aria-label="All maps" title="All maps">
          <House size={14} />
        </Link>

        {onBack && (
          <button className={styles.backIcon} onClick={onBack} aria-label="Back to map">
            <ChevronsLeft size={16} />
          </button>
        )}
        <div className={styles.scopeBadge}>
          <span className={styles.scopeValue}>{dataset?.id || '-'}</span>
        </div>

        {hasMultipleScopes && onScopeChange && (
          <div className={styles.scopeSelectWrap}>
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
            <ChevronDown size={12} className={styles.scopeSelectIcon} />
          </div>
        )}
      </div>
    </div>
  );
};

SubNav.propTypes = {
  dataset: PropTypes.object,
  scope: PropTypes.object,
  scopes: PropTypes.array,
  onScopeChange: PropTypes.func,
  onBack: PropTypes.func,
};

export default SubNav;
