import { ZipReader, BlobReader, TextWriter } from '@zip.js/zip.js';

function parseYtdAssignment(rawText) {
  const text = String(rawText || '').trim();
  const equalsIndex = text.indexOf('=');
  if (equalsIndex < 0) {
    throw new Error('Invalid X archive payload');
  }
  let payload = text.slice(equalsIndex + 1).trim();
  if (payload.endsWith(';')) {
    payload = payload.slice(0, -1).trim();
  }
  return JSON.parse(payload);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function profileFromArchive(accountRaw, profileRaw) {
  const account =
    Array.isArray(accountRaw) && accountRaw[0]?.account
      ? accountRaw[0].account
      : accountRaw?.account || accountRaw || {};

  const profile =
    Array.isArray(profileRaw) && profileRaw[0]?.profile
      ? profileRaw[0].profile
      : profileRaw?.profile || profileRaw || {};

  const description = profile?.description || {};
  return {
    username: account?.username || null,
    account_id: account?.accountId || null,
    display_name: account?.accountDisplayName || null,
    created_at: account?.createdAt || null,
    bio: description?.bio || '',
    website: description?.website || '',
    location: description?.location || '',
    avatar_url: profile?.avatarMediaUrl || null,
    header_url: profile?.headerMediaUrl || null,
  };
}

function minimizeTweetObject(tweetEntry, fallbackUsername = null) {
  const t = tweetEntry?.tweet || tweetEntry || {};
  const id = t.id_str || t.id;
  const text = t.full_text || t.text || '';
  if (!id || !text) {
    return null;
  }

  const urls = asArray(t?.entities?.urls)
    .map((url) => ({
      url: url?.url || null,
      expanded_url: url?.expanded_url || url?.url || null,
      display_url: url?.display_url || null,
      indices: Array.isArray(url?.indices) ? url.indices : null,
    }))
    .filter((url) => Boolean(url.expanded_url || url.url));

  const media = asArray(t?.extended_entities?.media)
    .map((m) => ({
      url: m?.url || null,
      expanded_url: m?.expanded_url || null,
      display_url: m?.display_url || null,
      indices: Array.isArray(m?.indices) ? m.indices : null,
      media_url_https: m?.media_url_https || m?.media_url || null,
      media_url: m?.media_url || null,
      type: m?.type || null,
    }))
    .filter((m) => Boolean(m.media_url_https || m.expanded_url || m.url));

  return {
    tweet: {
      id_str: String(id),
      created_at: t.created_at || null,
      full_text: String(text),
      favorite_count: t.favorite_count ?? 0,
      retweet_count: t.retweet_count ?? 0,
      reply_count: t.reply_count ?? 0,
      lang: t.lang || null,
      source: t.source || null,
      in_reply_to_status_id_str: t.in_reply_to_status_id_str || t.in_reply_to_status_id || null,
      in_reply_to_screen_name: t.in_reply_to_screen_name || null,
      quoted_status_id_str: t.quoted_status_id_str || t.quoted_status_id || null,
      conversation_id_str: t.conversation_id_str || t.conversation_id || null,
      entities: { urls },
      extended_entities: { media },
      user: { screen_name: t?.user?.screen_name || fallbackUsername || null },
      retweeted_status: t.retweeted_status ? {} : null,
    },
  };
}

function noteTweetToTweet(noteEntry, fallbackUsername = null) {
  const note = noteEntry?.noteTweet || noteEntry || {};
  const core = note?.core || {};
  const id = note.noteTweetId;
  const text = core.text || '';
  if (!id || !text) {
    return null;
  }

  const urls = asArray(core.urls)
    .map((u) => ({
      url: u?.url || null,
      expanded_url: u?.expandedUrl || u?.url || null,
      display_url: u?.displayUrl || null,
      indices: null,
    }))
    .filter((u) => Boolean(u.expanded_url || u.url));

  return {
    tweet: {
      id_str: String(id),
      created_at: note.createdAt || null,
      full_text: String(text),
      favorite_count: 0,
      retweet_count: 0,
      reply_count: 0,
      lang: null,
      source: null,
      in_reply_to_status_id_str: null,
      in_reply_to_screen_name: null,
      quoted_status_id_str: null,
      conversation_id_str: null,
      entities: { urls },
      extended_entities: { media: [] },
      user: { screen_name: fallbackUsername || null },
      retweeted_status: null,
    },
  };
}

function textFingerprint(text) {
  let t = String(text || '');
  // Strip leading @mention chains
  t = t.replace(/^(?:@\w+\s*)+/, '');
  // Decode common HTML entities
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Strip trailing ellipsis
  t = t.replace(/[\u2026.]{1,3}\s*$/, '');
  // Collapse whitespace and lowercase
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  return t.slice(0, 80);
}

function buildNoteTweetLookup(notesRaw) {
  const byId = new Map();
  const byFingerprint = new Map();

  for (const noteEntry of asArray(notesRaw)) {
    const note = noteEntry?.noteTweet || noteEntry || {};
    const core = note?.core || {};
    const text = core.text || '';
    const noteId = note.noteTweetId;
    if (!noteId || !text) continue;

    const urls = asArray(core.urls)
      .map((u) => u?.expandedUrl || u?.url)
      .filter(Boolean);

    const info = { noteId: String(noteId), text: String(text), urls };
    byId.set(String(noteId), info);
    const fp = textFingerprint(text);
    if (fp) byFingerprint.set(fp, info);
  }

  return { byId, byFingerprint };
}

function minimizeLikeObject(likeEntry) {
  const like = likeEntry?.like || likeEntry || {};
  const tweetId = like.tweetId || like.tweet_id || like.id_str || like.id;
  if (!tweetId) {
    return null;
  }
  const expandedUrl = like.expandedUrl || like.expanded_url || null;
  const fullText = like.fullText || like.full_text || like.text || '';

  return {
    like: {
      tweetId: String(tweetId),
      fullText: String(fullText || expandedUrl || ''),
      expandedUrl,
    },
  };
}

export async function extractTwitterArchiveForImport(file) {
  const reader = new ZipReader(new BlobReader(file));
  let accountText = '[]';
  let profileText = '[]';
  let tweetsText = '';
  let notesText = '[]';
  let likesText = '[]';

  try {
    const entries = await reader.getEntries();
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));

    const readText = async (path) => {
      const entry = byName.get(path);
      if (!entry) return null;
      return entry.getData(new TextWriter());
    };

    const tweets = await readText('data/tweets.js');
    if (!tweets) {
      throw new Error('Invalid X archive: missing data/tweets.js');
    }

    tweetsText = tweets;
    accountText = (await readText('data/account.js')) || '[]';
    profileText = (await readText('data/profile.js')) || '[]';
    notesText = (await readText('data/note-tweet.js')) || '[]';
    likesText = (await readText('data/like.js')) || '[]';
  } finally {
    await reader.close();
  }

  const accountRaw = parseYtdAssignment(accountText);
  const profileRaw = parseYtdAssignment(profileText);
  const tweetsRaw = parseYtdAssignment(tweetsText);
  const notesRaw = parseYtdAssignment(notesText);
  const likesRaw = parseYtdAssignment(likesText);

  const profile = profileFromArchive(accountRaw, profileRaw);
  const username = profile.username || null;

  // Build note tweet lookup for merging into parent tweets
  const { byId: noteById, byFingerprint: noteByFp } = buildNoteTweetLookup(notesRaw);
  const consumedNoteIds = new Set();

  const tweetEntries = asArray(tweetsRaw)
    .map((row) => {
      const minimized = minimizeTweetObject(row, username);
      if (!minimized) return null;

      const t = row?.tweet || row || {};
      let matched = null;

      // 1) Direct lookup via note_tweet reference in raw tweet object
      const noteRef = t.note_tweet?.note_tweet_id;
      if (noteRef && noteById.has(String(noteRef))) {
        matched = noteById.get(String(noteRef));
      }

      // 2) Fallback: fingerprint matching
      if (!matched) {
        const fp = textFingerprint(minimized.tweet.full_text);
        if (fp && noteByFp.has(fp)) {
          matched = noteByFp.get(fp);
        }
      }

      if (matched) {
        minimized.tweet.full_text = matched.text;
        // Merge URLs from note tweet
        const existingUrls = new Set(
          asArray(minimized.tweet.entities?.urls).map((u) => u.expanded_url),
        );
        for (const u of matched.urls) {
          if (!existingUrls.has(u)) {
            minimized.tweet.entities.urls.push({
              url: null,
              expanded_url: u,
              display_url: null,
              indices: null,
            });
          }
        }
        consumedNoteIds.add(matched.noteId);
      }

      return minimized;
    })
    .filter(Boolean);

  // Only include note tweets that weren't merged into a parent tweet
  const unmatchedNotes = asArray(notesRaw)
    .filter((noteEntry) => {
      const note = noteEntry?.noteTweet || noteEntry || {};
      return !consumedNoteIds.has(String(note.noteTweetId || ''));
    })
    .map((row) => noteTweetToTweet(row, username))
    .filter(Boolean);

  const tweets = [...tweetEntries, ...unmatchedNotes];
  const likes = asArray(likesRaw).map((row) => minimizeLikeObject(row)).filter(Boolean);

  if (!tweets.length && !likes.length) {
    throw new Error('No tweets or likes found in archive after local extraction');
  }

  return {
    profile,
    tweets,
    likes,
    tweet_count: tweets.length,
    likes_count: likes.length,
    total_count: tweets.length + likes.length,
    archive_format: 'x_native_extracted_v1',
  };
}
