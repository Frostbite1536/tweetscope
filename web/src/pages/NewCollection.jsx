import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { jobPolling } from '../components/Job/Run';
import JobProgress from '../components/Job/Progress';
import { Button, Input } from 'react-element-forge';
import { jobsApiUrl, catalogClient } from '../lib/apiService';
import { extractTwitterArchiveForImport } from '../lib/twitterArchiveParser';

import styles from './NewCollection.module.scss';

const substackUrl = (import.meta.env.VITE_SUBSTACK_URL || '').replace(/\/+$/, '');

const readonly = import.meta.env.MODE === 'read_only';

function WaitlistCard() {
  return (
    <div className={styles.waitlistCard}>
      <h3 className={styles.waitlistTitle}>Coming Soon</h3>
      <p className={styles.waitlistDescription}>
        The ability to explore your own Twitter profile is coming soon.
        {substackUrl ? ' Subscribe to get notified when it\u2019s ready.' : ''}
      </p>

      {substackUrl && (
        <div className={styles.waitlistEmbed}>
          <iframe
            src={`${substackUrl}/embed`}
            width="100%"
            height="150"
            className={styles.substackIframe}
            frameBorder="0"
            scrolling="no"
            title="Subscribe for updates"
          />
        </div>
      )}
    </div>
  );
}

function NewCollection({ appConfig = null }) {
  const features = appConfig?.features || {};
  const limits = appConfig?.limits || {};
  const canTwitterImport = features.twitter_import ?? !readonly;
  const maxUploadMb = limits.max_upload_mb;
  const navigate = useNavigate();

  // Fetch datasets only for name-collision detection
  const [datasets, setDatasets] = useState([]);
  useEffect(() => {
    catalogClient.fetchDatasets().then(setDatasets);
  }, []);

  // Archive import state
  const [twitterImportJob, setTwitterImportJob] = useState(null);
  const [twitterArchiveFile, setTwitterArchiveFile] = useState(null);
  const [twitterArchiveDatasetName, setTwitterArchiveDatasetName] = useState('');
  const [twitterArchiveYear, setTwitterArchiveYear] = useState('');
  const [twitterArchiveIncludeLikes, setTwitterArchiveIncludeLikes] = useState(true);
  const [twitterArchiveExtracting, setTwitterArchiveExtracting] = useState(false);
  const [localExtractedRecordCount, setLocalExtractedRecordCount] = useState(null);

  // Community import state
  const [communityUsername, setCommunityUsername] = useState('');
  const [communityDatasetName, setCommunityDatasetName] = useState('');
  const [communityYear, setCommunityYear] = useState('');

  // Shared state
  const [twitterImportError, setTwitterImportError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const parseApiResponse = useCallback(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  }, []);

  function sanitizeName(fileName) {
    let name = fileName.substring(0, fileName.lastIndexOf('.'));
    name = name.replace(/\s/g, '-');
    return name;
  }

  const handleTwitterArchiveSelected = useCallback((event) => {
    const file = event.target.files?.[0];
    setTwitterArchiveFile(file || null);
    setLocalExtractedRecordCount(null);
    if (file?.name) {
      setTwitterArchiveDatasetName(sanitizeName(file.name));
    }
  }, []);

  const submitTwitterArchiveImport = useCallback(
    async (event) => {
      event.preventDefault();
      if (!twitterArchiveFile || !twitterArchiveDatasetName) return;
      setTwitterImportError('');
      setTwitterImportJob(null);
      setLocalExtractedRecordCount(null);
      const formData = new FormData();
      formData.append('dataset', twitterArchiveDatasetName);
      formData.append('run_pipeline', 'true');
      formData.append('include_likes', twitterArchiveIncludeLikes ? 'true' : 'false');
      if (twitterArchiveYear) {
        formData.append('year', twitterArchiveYear);
      }
      try {
        setTwitterArchiveExtracting(true);
        const extracted = await extractTwitterArchiveForImport(twitterArchiveFile);
        const recordCount =
          extracted?.total_count ||
          (extracted?.tweet_count || extracted?.tweets?.length || 0) +
            (extracted?.likes_count || extracted?.likes?.length || 0);
        setLocalExtractedRecordCount(recordCount || null);
        const payload = JSON.stringify(extracted);
        const extractedFile = new File([payload], `twitter-extract-${Date.now()}.json`, {
          type: 'application/json',
        });
        formData.append('source_type', 'community_json');
        formData.append('file', extractedFile);

        const data = await fetch(`${jobsApiUrl}/jobs/import_twitter`, {
          method: 'POST',
          body: formData,
        }).then(parseApiResponse);
        jobPolling({ id: data.dataset || twitterArchiveDatasetName }, setTwitterImportJob, data.job_id);
      } catch (error) {
        console.error('Error:', error);
        setTwitterImportError(error.message || 'Failed to start import');
      } finally {
        setTwitterArchiveExtracting(false);
      }
    },
    [
      twitterArchiveFile,
      twitterArchiveDatasetName,
      twitterArchiveYear,
      twitterArchiveIncludeLikes,
      parseApiResponse,
    ]
  );

  const submitCommunityImport = useCallback(
    (event) => {
      event.preventDefault();
      if (!communityUsername || !communityDatasetName) return;
      setTwitterImportError('');
      setTwitterImportJob(null);

      const formData = new FormData();
      formData.append('dataset', communityDatasetName);
      formData.append('source_type', 'community');
      formData.append('run_pipeline', 'true');
      formData.append('username', communityUsername);
      if (communityYear) {
        formData.append('year', communityYear);
      }

      fetch(`${jobsApiUrl}/jobs/import_twitter`, {
        method: 'POST',
        body: formData,
      })
        .then(parseApiResponse)
        .then((data) => {
          jobPolling({ id: data.dataset || communityDatasetName }, setTwitterImportJob, data.job_id);
        })
        .catch((error) => {
          console.error('Error:', error);
          setTwitterImportError(error.message || 'Failed to start import');
        });
    },
    [communityUsername, communityDatasetName, communityYear, parseApiResponse]
  );

  // Navigate to explore on job completion
  useEffect(() => {
    if (!twitterImportJob || twitterImportJob.status !== 'completed') return;

    const datasetId = twitterImportJob.dataset;
    const scopeId = twitterImportJob.scope_id;
    if (datasetId && scopeId) {
      navigate(`/datasets/${datasetId}/explore/${scopeId}`);
      return;
    }

    if (datasetId) {
      catalogClient.fetchScopes(datasetId).then((scopeRows) => {
        const sorted = [...scopeRows].sort((a, b) => a.id.localeCompare(b.id));
        const latest = sorted[sorted.length - 1];
        if (latest?.id) {
          navigate(`/datasets/${datasetId}/explore/${latest.id}`);
        } else {
          navigate('/');
        }
      });
    }
  }, [twitterImportJob, navigate]);

  // Name collision checks
  const archiveNameTaken = datasets.some((d) => d.id === twitterArchiveDatasetName);
  const likesNameTaken = twitterArchiveIncludeLikes &&
    datasets.some((d) => d.id === `${twitterArchiveDatasetName}-likes`);
  const communityNameTaken = datasets.some((d) => d.id === communityDatasetName);

  const isDisabled = readonly || !canTwitterImport;

  return (
    <div className={styles.newCollection}>
      <Link to="/" className={styles.backLink}>
        &larr; Back to collections
      </Link>

      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>Build Your Knowledge Map</h1>
        <p className={styles.heroSubtitle}>
          Upload your X archive or fetch from Community Archive to create an interactive knowledge map
        </p>
      </div>

      {isDisabled && <WaitlistCard />}

      <div className={isDisabled ? styles.disabledOverlay : styles.importRow} inert={isDisabled ? '' : undefined}>
        {/* Native Archive Import */}
        <div className={styles.glassCard}>
          <form onSubmit={submitTwitterArchiveImport} className={styles.cardForm}>
            <h3 className={styles.cardTitle}>Upload native X archive</h3>
            <p className={styles.cardDescription}>
              Upload your X export zip and auto-build your knowledge map
            </p>

            {maxUploadMb ? <span className={styles.uploadLimit}>Upload limit: {maxUploadMb} MB</span> : null}

            <div className={styles.helperNote}>
              Archive zip is processed locally in your browser. Only extracted tweet payload is uploaded.
            </div>

            {/* Styled file drop zone */}
            <label htmlFor="twitter-archive-upload" className={styles.dropZone}>
              <input
                id="twitter-archive-upload"
                className={styles.hiddenInput}
                type="file"
                accept=".zip"
                onChange={handleTwitterArchiveSelected}
              />
              <span className={styles.dropZoneIcon}>&#128230;</span>
              {twitterArchiveFile ? (
                <span className={styles.dropZoneFileName}>{twitterArchiveFile.name}</span>
              ) : (
                <span className={styles.dropZoneText}>Click to select your .zip archive</span>
              )}
            </label>

            <Input
              id="twitter-archive-dataset-name"
              type="text"
              placeholder="Collection name"
              value={twitterArchiveDatasetName}
              onChange={(e) => setTwitterArchiveDatasetName(e.target.value)}
            />

            {/* Advanced options toggle */}
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              Advanced options {showAdvanced ? '\u25BE' : '\u25B8'}
            </button>

            <div className={`${styles.advancedSection} ${showAdvanced ? styles.advancedOpen : ''}`}>
              <Input
                id="twitter-archive-year"
                type="number"
                placeholder="Optional year filter (e.g. 2025)"
                value={twitterArchiveYear}
                onChange={(e) => setTwitterArchiveYear(e.target.value)}
              />
              <label className={styles.checkboxRow} htmlFor="twitter-include-likes">
                <input
                  id="twitter-include-likes"
                  type="checkbox"
                  checked={twitterArchiveIncludeLikes}
                  onChange={(e) => setTwitterArchiveIncludeLikes(e.target.checked)}
                />
                <div>
                  <div className={styles.checkboxLabel}>Include likes as separate collection</div>
                  <div className={styles.checkboxHint}>
                    {twitterArchiveIncludeLikes
                      ? 'Likes will be imported into a separate collection.'
                      : 'Likes will not be imported.'}
                  </div>
                </div>
              </label>
            </div>

            {archiveNameTaken ? (
              <div className={styles.warningBanner}>This collection name is already taken.</div>
            ) : null}
            {likesNameTaken ? (
              <div className={styles.warningBanner}>
                The likes collection name ({twitterArchiveDatasetName}-likes) is already taken.
              </div>
            ) : null}

            <Button
              type="submit"
              disabled={
                !twitterArchiveFile ||
                !twitterArchiveDatasetName ||
                archiveNameTaken ||
                likesNameTaken ||
                twitterArchiveExtracting
              }
              text={twitterArchiveExtracting ? 'Processing archive locally...' : 'Build Collection'}
            />
          </form>

          {localExtractedRecordCount ? (
            <div className={styles.countBadge}>
              Prepared {localExtractedRecordCount} records locally for upload.
            </div>
          ) : null}
        </div>

        {/* Community Archive Import */}
        <div className={styles.glassCard}>
          <form onSubmit={submitCommunityImport} className={styles.cardForm}>
            <h3 className={styles.cardTitle}>Fetch from Community Archive</h3>
            <p className={styles.cardDescription}>
              Fetch a public archive by username and auto-build your knowledge map
            </p>
            <div className={styles.helperNote}>
              Note: community archives may not include likes yet.
            </div>

            <Input
              id="community-username"
              type="text"
              placeholder="Username (without @)"
              value={communityUsername}
              onChange={(e) => setCommunityUsername(e.target.value)}
            />
            <Input
              id="community-dataset-name"
              type="text"
              placeholder="Collection name"
              value={communityDatasetName}
              onChange={(e) => setCommunityDatasetName(e.target.value)}
            />

            {/* Advanced options for community */}
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              Advanced options {showAdvanced ? '\u25BE' : '\u25B8'}
            </button>

            <div className={`${styles.advancedSection} ${showAdvanced ? styles.advancedOpen : ''}`}>
              <Input
                id="community-year"
                type="number"
                placeholder="Optional year filter (e.g. 2025)"
                value={communityYear}
                onChange={(e) => setCommunityYear(e.target.value)}
              />
            </div>

            {communityNameTaken ? (
              <div className={styles.warningBanner}>This collection name is already taken.</div>
            ) : null}

            <Button
              type="submit"
              disabled={!communityUsername || !communityDatasetName || communityNameTaken}
              text="Build from Community Archive"
            />
          </form>
        </div>
      </div>

      {/* Global import error */}
      {twitterImportError ? (
        <div className={styles.globalError}>{twitterImportError}</div>
      ) : null}

      {/* Job progress */}
      {twitterImportJob ? (
        <div className={styles.jobWrapper}>
          <JobProgress job={twitterImportJob} clearJob={() => setTwitterImportJob(null)} />
        </div>
      ) : null}
    </div>
  );
}

NewCollection.propTypes = {
  appConfig: PropTypes.object,
};

export default NewCollection;
