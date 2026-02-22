import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { apiUrl, catalogClient } from '../lib/apiService';
import ScopeThumbnail from '../components/ScopeThumbnail';

import styles from './Dashboard.module.scss';

function Dashboard({ appConfig = null }) {
  const [datasets, setDatasets] = useState([]);
  const [scopes, setScopes] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    catalogClient.fetchDatasets().then(setDatasets).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    datasets.forEach((dataset) => {
      catalogClient.fetchScopes(dataset.id).then((data) =>
        setScopes((prev) => ({ ...prev, [dataset.id]: data }))
      );
    });
  }, [datasets]);

  // Group datasets: merge {name}-likes with its parent into one card
  const collections = useMemo(() => {
    const datasetMap = new Map(datasets.map((d) => [d.id, d]));
    const likesIds = new Set();

    for (const ds of datasets) {
      if (ds.id.endsWith('-likes')) {
        const parentId = ds.id.slice(0, -6);
        if (datasetMap.has(parentId)) {
          likesIds.add(ds.id);
        }
      }
    }

    const grouped = [];
    for (const ds of datasets) {
      if (likesIds.has(ds.id)) continue;

      const likesId = `${ds.id}-likes`;
      const likesDataset = datasetMap.has(likesId) && likesIds.has(likesId)
        ? datasetMap.get(likesId)
        : null;

      const tweetsScopes = scopes[ds.id] || [];
      const likesScopes = likesDataset ? (scopes[likesId] || []) : [];

      grouped.push({
        id: ds.id,
        tweetsDataset: ds,
        likesDataset,
        tweetsScopes,
        likesScopes,
        tweetCount: ds.row_count ?? ds.length ?? 0,
        likesCount: likesDataset ? (likesDataset.row_count ?? likesDataset.length ?? 0) : 0,
      });
    }

    return grouped;
  }, [datasets, scopes]);

  const canCreate = appConfig?.features?.twitter_import ?? true;

  return (
    <div className={styles.dashboard}>
      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>Tweetscope</h1>
        <p className={styles.heroSubtitle}>Explore your knowledge maps</p>
      </div>

      <div className={styles.collectionsSection}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Your Collections</h3>
          <Link to="/new" className={styles.newCollectionButton}>
            {canCreate ? '+ New Collection' : (
              <>Import a Twitter Account <span className={styles.comingSoonBadge}>Coming Soon</span></>
            )}
          </Link>
        </div>

        {canCreate ? (
          <div className={styles.collectionsList}>
            {loading ? (
              <div className={styles.emptyState}>Loading collections...</div>
            ) : collections.length === 0 ? (
              <div className={styles.emptyState}>
                No collections yet.{' '}
                <Link to="/new" className={styles.emptyLink}>
                  Build your first knowledge map
                </Link>
              </div>
            ) : (
              collections.map((collection) => (
                <CollectionCard key={collection.id} collection={collection} />
              ))
            )}
          </div>
        ) : (
          <div className={styles.emptyState}>
            Import your Twitter archive and explore it as a visual knowledge base.{' '}
            <Link to="/new" className={styles.emptyLink}>Join the waitlist</Link> to get notified.
          </div>
        )}
      </div>

      {!canCreate && collections.length > 0 && (
        <div className={styles.collectionsSection}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Public Maps</h3>
          </div>
          <div className={styles.collectionsList}>
            {collections.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeGrid({ datasetId, scopeList, typeLabel }) {
  if (!scopeList || scopeList.length === 0) return null;
  return (
    <div className={styles.scopeGrid}>
      {scopeList.map((scope, i) => {
        const label = typeLabel
          ? (scopeList.length > 1 ? `${typeLabel} — ${scope.label || scope.id}` : typeLabel)
          : (scope.label || scope.id);
        return (
          <Link
            className={styles.scopeCard}
            to={`/datasets/${datasetId}/explore/${scope.id}`}
            key={i}
          >
            <span className={styles.scopeLabel}>{label}</span>
            <ScopeThumbnail
              datasetId={datasetId}
              scopeId={scope.id}
              className={styles.scopeImage}
              fallbackSrc={
                scope.ignore_hulls
                  ? `${apiUrl}/files/${datasetId}/umaps/${scope.umap_id}.png`
                  : `${apiUrl}/files/${datasetId}/clusters/${scope.cluster_id}.png`
              }
              alt={label}
            />
            {scope.description ? (
              <span className={styles.scopeDescription}>{scope.description}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

function CollectionCard({ collection }) {
  const {
    id, tweetsDataset, likesDataset,
    tweetsScopes, likesScopes,
    tweetCount, likesCount,
  } = collection;

  const profile = tweetsDataset.profile || likesDataset?.profile;
  const displayName = profile?.display_name || id;
  const username = profile?.username;

  const statParts = [];
  statParts.push(`${tweetCount.toLocaleString()} tweets`);
  if (likesCount > 0) {
    statParts.push(`${likesCount.toLocaleString()} likes`);
  }

  const hasLikes = likesScopes.length > 0;

  return (
    <div className={styles.collectionCard}>
      <div className={styles.collectionHeader}>
        <h3 className={styles.collectionName}>
          {displayName}
          {username && <span className={styles.collectionUsername}> @{username}</span>}
        </h3>
        <span className={styles.collectionStats}>{statParts.join(' · ')}</span>
      </div>

      <ScopeGrid
        datasetId={tweetsDataset.id}
        scopeList={tweetsScopes}
        typeLabel={hasLikes ? 'Posted Tweets' : undefined}
      />

      {hasLikes && (
        <ScopeGrid
          datasetId={likesDataset.id}
          scopeList={likesScopes}
          typeLabel="Liked Tweets"
        />
      )}

    </div>
  );
}

Dashboard.propTypes = {
  appConfig: PropTypes.object,
};

CollectionCard.propTypes = {
  collection: PropTypes.object.isRequired,
};

ScopeGrid.propTypes = {
  datasetId: PropTypes.string.isRequired,
  scopeList: PropTypes.array.isRequired,
  typeLabel: PropTypes.string,
};

export default Dashboard;
