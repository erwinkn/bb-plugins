-- Schema of the live Initiatives database at bb-plugins 3d46353 (2026-10-14), from a read-only
-- backup copy: tables, indexes and the SDK's migration ledger. No row data except _bb_migrations.
CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT);
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    member_project_ids TEXT NOT NULL,
    coordinator_thread_id TEXT,
    coordinator_generation INTEGER NOT NULL DEFAULT 0,
    checkpoint TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    policy TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  , context TEXT NOT NULL DEFAULT '{}', coordinator_stopped_at INTEGER, coordinator_continued_at INTEGER, appearance TEXT);
CREATE TABLE tasks (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    brief TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    depends_on TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    profile_override TEXT,
    profile_source TEXT,
    progress TEXT,
    next_checkpoint TEXT,
    result TEXT,
    accepted_assignment INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  );
CREATE TABLE workers (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    role TEXT NOT NULL,
    label TEXT NOT NULL,
    area TEXT NOT NULL,
    thread_id TEXT,
    generation INTEGER NOT NULL,
    bb_project_id TEXT NOT NULL,
    environment_id TEXT,
    provider_id TEXT,
    model TEXT,
    reasoning_level TEXT,
    state TEXT NOT NULL,
    retention TEXT,
    handoff TEXT,
    forked_from INTEGER,
    native_parent INTEGER NOT NULL DEFAULT 0,
    user_stopped INTEGER NOT NULL DEFAULT 0,
    intervention_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, kind TEXT,
    PRIMARY KEY (project_id, num)
  );
CREATE INDEX workers_thread ON workers(thread_id);
CREATE TABLE generations (
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    provider_thread_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT, hold_reason TEXT,
    PRIMARY KEY (project_id, worker_num, generation)
  );
CREATE INDEX generations_thread ON generations(thread_id);
CREATE TABLE assignments (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    worker_num INTEGER NOT NULL,
    task_nums TEXT NOT NULL,
    route TEXT NOT NULL,
    role TEXT NOT NULL,
    work_kind TEXT,
    thread_id TEXT,
    generation INTEGER NOT NULL,
    profile TEXT NOT NULL,
    actual_profile TEXT,
    fingerprint TEXT,
    bb_project_id TEXT NOT NULL,
    environment_id TEXT,
    state TEXT NOT NULL,
    op_id TEXT NOT NULL UNIQUE,
    op_state TEXT NOT NULL,
    queued_message_id TEXT,
    brief_text TEXT NOT NULL,
    review_of TEXT,
    rationale TEXT,
    report TEXT,
    reported_at INTEGER,
    stop_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, review_key TEXT, brief_delivered INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, pending_identity TEXT, access TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('read-only','write')), checkpoint TEXT, review_targets TEXT, report_notice TEXT, write_scope TEXT, scope_release TEXT, report_seq INTEGER NOT NULL DEFAULT 0, handoff_sources TEXT, label TEXT,
    PRIMARY KEY (project_id, num)
  );
CREATE INDEX assignments_thread ON assignments(thread_id);
CREATE INDEX assignments_queued ON assignments(queued_message_id);
CREATE TABLE knowledge (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    topic TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    human_attention TEXT NOT NULL,
    blocks TEXT NOT NULL,
    deadline TEXT,
    provenance TEXT NOT NULL,
    supersedes INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, decision_owner TEXT, decision_review TEXT, decision_review_message TEXT, decision_notification TEXT,
    PRIMARY KEY (project_id, num)
  );
CREATE TABLE updates (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  );
CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    priority TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL,
    batch_id INTEGER,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
CREATE INDEX inbox_pending ON inbox(project_id, state);
CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    coordinator_thread_id TEXT NOT NULL,
    marker TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    ref TEXT
  );
CREATE INDEX activity_project ON activity(project_id, id);
CREATE TABLE usage (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    provider_thread_id TEXT,
    session_totals TEXT,
    closed_totals TEXT NOT NULL,
    resets INTEGER NOT NULL DEFAULT 0,
    last_report_at INTEGER,
    context_used INTEGER,
    context_window INTEGER,
    model TEXT,
    updated_at INTEGER NOT NULL
  , context_estimated INTEGER, context_changed_at INTEGER, context_observed_at INTEGER, first_observed_at INTEGER, last_observed_at INTEGER, profile_observation TEXT);
CREATE TABLE leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    fingerprint TEXT,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    max_refreshes INTEGER NOT NULL,
    refreshes INTEGER NOT NULL DEFAULT 0,
    deadline INTEGER NOT NULL,
    capability TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT
  );
CREATE TABLE coordinator_starts (
    project_id TEXT PRIMARY KEY, op_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, thread_id TEXT, reason TEXT, created_at INTEGER NOT NULL
  );
CREATE TABLE worker_messages (op_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worker_num INTEGER NOT NULL, generation INTEGER NOT NULL, thread_id TEXT NOT NULL, assignment_num INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, queued_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE coordinator_handovers (
    project_id TEXT PRIMARY KEY,
    thread_id TEXT,
    reason TEXT NOT NULL,
    profile TEXT,
    requested_by TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , revision INTEGER NOT NULL DEFAULT 1, environment TEXT);
CREATE TABLE handover_counters (
    project_id TEXT PRIMARY KEY,
    next_revision INTEGER NOT NULL
  );
CREATE TABLE project_threads (
    project_id TEXT NOT NULL,
    op_id TEXT PRIMARY KEY,
    thread_id TEXT UNIQUE,
    label TEXT NOT NULL,
    bb_project_id TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER
  , discussion INTEGER NOT NULL DEFAULT 0);
CREATE INDEX project_threads_project ON project_threads(project_id);
CREATE TABLE project_nested_threads (
    project_id TEXT NOT NULL,
    thread_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    bb_project_id TEXT,
    created_at INTEGER NOT NULL
  );
CREATE INDEX project_nested_threads_project ON project_nested_threads(project_id);
CREATE TABLE usage_turn_cursors (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL, first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL
  );
CREATE TABLE usage_turns (
    thread_id TEXT NOT NULL, turn_key TEXT NOT NULL, turn_id TEXT,
    started_at INTEGER, completed_at INTEGER, status TEXT,
    start_seq INTEGER, completion_seq INTEGER,
    PRIMARY KEY(thread_id, turn_key)
  );
CREATE TABLE legacy_session_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE _initiatives_migration (
      id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, report TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE _initiatives_migration_threads (
      direction TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      before TEXT, detail TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (direction, thread_id, kind));
CREATE TABLE plugin_flags (key TEXT PRIMARY KEY, set_at INTEGER NOT NULL);
CREATE TABLE handover_drafts (
    project_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('requested','generating','ready')),
    note TEXT,
    text TEXT,
    source TEXT CHECK (source IN ('luna','fallback','user')),
    thread_id TEXT,
    detail TEXT,
    then_replace TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , fallback TEXT, fingerprint TEXT, captured_at INTEGER, purpose TEXT);
CREATE TABLE handover_writers (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pr_stages (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    stage TEXT NOT NULL,
    note TEXT,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, url)
  );
CREATE TABLE memory_settings (project_id TEXT PRIMARY KEY, mode TEXT NOT NULL, compact_tokens INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE memory_log (project_id TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, thread_id TEXT, seq INTEGER, PRIMARY KEY (project_id, i));
CREATE TABLE memory_cursors (project_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_seq INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, thread_id));
CREATE TABLE memory_nodes (project_id TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, how TEXT NOT NULL, tries INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, l, i));
CREATE TABLE memory_trees (project_id TEXT PRIMARY KEY, views TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, call_ms INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, nodes INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE pr_records (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    stage TEXT,
    note TEXT,
    stage_set_at INTEGER,
    category TEXT,
    waiting_on TEXT,
    changes TEXT,
    decision TEXT,
    worker TEXT,
    assignment TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, url)
  );
CREATE TABLE pr_notes (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    author TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    link TEXT,
    answered_at INTEGER,
    answered_by TEXT,
    answer TEXT,
    PRIMARY KEY (project_id, url, n)
  );
CREATE INDEX assignments_open_review ON assignments(project_id, json_extract(handoff_sources, '$[0].assignment'),
    json_extract(handoff_sources, '$[0].reportVersion'), num) WHERE role = 'review' AND state IN ('dispatching', 'queued', 'running');
CREATE TABLE write_receipts (
    key TEXT PRIMARY KEY,
    project_id TEXT,
    command TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL
  );
CREATE INDEX write_receipts_created ON write_receipts(created_at);
CREATE TABLE pr_stage_changes (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    author TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT,
    note TEXT,
    PRIMARY KEY (project_id, url, n)
  );
INSERT INTO _bb_migrations VALUES(0,1791296030232,'ff0f16c73f2dbdaf42ade9cef9a2c25d37b716521b4cd57c3890dae47e2527d1');
INSERT INTO _bb_migrations VALUES(1,1791296030232,'337617c5aa14c8ebabc4bb637793af20c2cb84df8453276e4253de908e3d85fe');
INSERT INTO _bb_migrations VALUES(2,1791296030232,'56867818726dcaf0d997f0a1c98abcec7d86301eda7a613670d424eaacad6695');
INSERT INTO _bb_migrations VALUES(3,1791296030232,'ad7d018cf97c4f967a0536c90a5614fd6413f9f2c7ee5363b80090c066949fd0');
INSERT INTO _bb_migrations VALUES(4,1791296030232,'fcee8c278bf640dcc0d7dc8c0e06aefb2a2688b9c306a75781f4f7e107719bc1');
INSERT INTO _bb_migrations VALUES(5,1791296030232,'387c61fcc5a73de434de454960cbcd76a85bbb2c639bf7a7816e186a9a9bbf62');
INSERT INTO _bb_migrations VALUES(6,1791296030232,'6d71f2178a5f37780f3e7b47c852f00ad8742d6fef11e6ed2657b6e705fb2aca');
INSERT INTO _bb_migrations VALUES(7,1791296030232,'b1ccdda587df8699da469a2359585ac547af1f3abec71442a32ad3f9b36c1a2a');
INSERT INTO _bb_migrations VALUES(8,1791296030232,'d6ea1f55aaf1586661b912304275a75c99171205a705b8fc5625ba27dea2de03');
INSERT INTO _bb_migrations VALUES(9,1791296030232,'d765210816b2e3db6dbdfaffb7a6ad12abf9bfb9eb5a450d4e5f015014f5671e');
INSERT INTO _bb_migrations VALUES(10,1791296030232,'04a34a1ada2cc62edd270cb1182518c20b805f91dc5bcf2bb0b249a92ae1d32b');
INSERT INTO _bb_migrations VALUES(11,1791296030232,'04084e1158a3ecf563192be657b81c6ddc15764eaedd133c33d4e15a4874096c');
INSERT INTO _bb_migrations VALUES(12,1791296030232,'b8feefb4337c156346d48e8a18d68ac3e793b3ca3c86b51e6c0653facb05f290');
INSERT INTO _bb_migrations VALUES(13,1791296030232,'4d9a4b5881c86a911965bc0a0ab7d0d73a10b628ed136e402992c0510d86a34c');
INSERT INTO _bb_migrations VALUES(14,1791296030232,'3723c95683aefe658c550f44240c3ddaff5b9768c5e6c27ebb0f5fa2ff771000');
INSERT INTO _bb_migrations VALUES(15,1791296030232,'7cbc6e1d4e33c833aff52fd3ff90dc65d2b7da0242df69fe8c567194426d5394');
INSERT INTO _bb_migrations VALUES(16,1791296030232,'e6a6b26d55366a02d3fce48bf36178508188fe91bc7eac7388cb5c15ec35693c');
INSERT INTO _bb_migrations VALUES(17,1791296030233,'9a6e575a4d0dc0562836164c7a799f3ad12bcd64d5493d8def2f95e1e95ed7da');
INSERT INTO _bb_migrations VALUES(18,1791296030233,'8e7af0e4e6d5925e6556ecf89cadb0e76fffeea27f731fab89c46ab85662cdde');
INSERT INTO _bb_migrations VALUES(19,1791296030233,'d26a22f1d89fc91188100d02b4f05494e1ebde95e0e5072c9467930cbf0f63ae');
INSERT INTO _bb_migrations VALUES(20,1791296030233,'fa4375c23dc9fe4685b6813372d82134637bd3ae25b900dacd95ab93f4124956');
INSERT INTO _bb_migrations VALUES(21,1791296030233,'a6590a1f2fc97f75ca5c47eee07c74f756af3cf90a38042dbb98d424f531ef3e');
INSERT INTO _bb_migrations VALUES(22,1791296030233,'63ed0244e543600f5f98081d9e4580bf97a4a2ebe97574f6eb7eb29001f88a41');
INSERT INTO _bb_migrations VALUES(23,1791296030233,'a3590cb24638f7de970077420beb3a230ae535e076fddfc2b796255a9ebb89aa');
INSERT INTO _bb_migrations VALUES(24,1791296030233,'c103a619f5183c0da8d8c74ddc0882dcaec1a6b5e3fddaee74a79cf5f34f59a2');
INSERT INTO _bb_migrations VALUES(25,1791296030233,'9d80738674f73ca0e99e5650660ad237620208bcab1e2737ce11a1c1e2ea0aa9');
INSERT INTO _bb_migrations VALUES(26,1791296030233,'075bcc71fcc795aaff7d2c36398f4c845e8ca066b86284c928644aaa9361e001');
INSERT INTO _bb_migrations VALUES(27,1791296030233,'34d754a033c0121065e7d249815425bb8f21ed8c7aa157fc88ff119722609133');
INSERT INTO _bb_migrations VALUES(28,1791296030234,'68d5567097d78556339447221bdc254a58b0de41c7152fca7faa395a056e7e21');
INSERT INTO _bb_migrations VALUES(29,1791296030234,'1672afffcc2c75e1615a76767bf9d136d98eaf3a3e2bbd1287bb23b91bcbc670');
INSERT INTO _bb_migrations VALUES(30,1791296030234,'64ca0f954a56334ac5c3d5dd4fffa94703e713cf225fd622eebd2f312eb87bbd');
INSERT INTO _bb_migrations VALUES(31,1791296030234,'d93da47966aa4bc34558cc233b70c21c191a0dffd852007e6e89892dec1c3f6a');
INSERT INTO _bb_migrations VALUES(32,1791296030234,'602ae596e8f60d03d6343c3ff7bd033c0c56d6644fa1512d2491faf6a5862860');
INSERT INTO _bb_migrations VALUES(33,1791296030234,'8eea7238d0b4a5ac9187421d1d833c91d105d27e1c7980e3ce106136f5818447');
INSERT INTO _bb_migrations VALUES(34,1791296030234,'5871e248e27a2e90a5e70c4aec9b3234287b8b8e504839365f1aac65d70d473c');
INSERT INTO _bb_migrations VALUES(35,1791296030234,'871caa8408b6489671ffd7b4426d4d833965e556d2ded70231f243f7b67a8ead');
INSERT INTO _bb_migrations VALUES(36,1791296030234,'42e6b35ee202776108389e76912b337256debdfdfd897735d59cd877f2bdd430');
INSERT INTO _bb_migrations VALUES(37,1791296030234,'edf05730de7f822bcea1e7b982e404a861466120098a883c824cd53aa16bb3b8');
INSERT INTO _bb_migrations VALUES(38,1791296030234,'651a72bfe18c92a5f73e82b4592392d3adb6ffb71a2d2825a5f8e0a9f899edd2');
INSERT INTO _bb_migrations VALUES(39,1791296030234,'2fd312aa2ea9dbebec94150d2f67539babf6b48fbd69fae2ecae6e5e600e5c6c');
INSERT INTO _bb_migrations VALUES(40,1791296030234,'e66ed1297b5f615c97e3f1b4dadcd4a8c7346b119a95d01aabacc7a2f3da73c0');
INSERT INTO _bb_migrations VALUES(41,1791296030235,'3304c188202bf09db2df77849d7ae9dd03f2238fc83b596531f4b1442d531d00');
INSERT INTO _bb_migrations VALUES(42,1791296030235,'760947f15576897d6b97ccd7969fb5c7b6ed94b8e2b4713b890c3b8a9f4a5c98');
INSERT INTO _bb_migrations VALUES(43,1791296030235,'34d58b2c2cf0deed644f29413d7f91b21442db2ca847832ef4c6c5482e808a4b');
INSERT INTO _bb_migrations VALUES(44,1791296030235,'239a27d06f2f065bce5e6dbe1ade7db3320101f489dd3318702bb7f28d2896a8');
INSERT INTO _bb_migrations VALUES(45,1791296030235,'0ac2230a1745647c560aecd956cf5f0d14d347930d8ca8c63f61ff387a103eba');
INSERT INTO _bb_migrations VALUES(46,1791296030235,'41810771588a83f46ec955936ff968239a1eccd7d4ed8c11244c6b9a052405b2');
INSERT INTO _bb_migrations VALUES(47,1791296030235,'73f33b1b682bb1c95f577eedd154c5080c21e821ba27fc5d42c3ad58143a2d26');
INSERT INTO _bb_migrations VALUES(48,1791296030235,'3b1215f0bdbcd603e36590ac95ec0bf52a5c600e5c5dfcd7970d5f188bbacdfd');
INSERT INTO _bb_migrations VALUES(49,1791296030235,'bcac823ffbc18d3b179e601145aa70e00a2ba8d2a9f4fd3e9cbd42c223d9e9dc');
INSERT INTO _bb_migrations VALUES(50,1791296030235,'28068bc5855f8c8c65f2c9ff63eb2823862c3615b83f3f61e46ca76a6227c965');
INSERT INTO _bb_migrations VALUES(51,1791296030235,'729a872adf4aadaed928b32d11986eca5ecac75b32afa3472308c8a565dde21a');
INSERT INTO _bb_migrations VALUES(52,1791296030235,'3c6f38324479eefba1c039048233b2537d90f06ed774b12d85280c107bf0be24');
INSERT INTO _bb_migrations VALUES(53,1791296030235,'63c982a5761d42ee957fa82e90fecc7705283faa429e5c930444ee72bff34098');
INSERT INTO _bb_migrations VALUES(54,1791296030236,'3dfdb925460d749ca317c8c374099917beafca7afc95417088ae1f8dd0ebc6ef');
INSERT INTO _bb_migrations VALUES(55,1791296030236,'2c548aa726eab3dcdf540da4b64e087070c20b06efe9c644976010ed3b0e0649');
INSERT INTO _bb_migrations VALUES(56,1791296030236,'82135e61455124a0da4cf34f2ad462d71796336dc0837da9363c03b6ad746e59');
INSERT INTO _bb_migrations VALUES(57,1791296030236,'17c0af8c130084c007391c632868d9df239f6a85b3873243519670f070ac5eb8');
INSERT INTO _bb_migrations VALUES(58,1791296030236,'5b11ba2baf81b58fc09ab3c04cf84b73cf85e3378e9f3a848fc15f4567e4ca58');
INSERT INTO _bb_migrations VALUES(59,1791296030236,'6589618bc5a1b13459126d221a077bc443c91f14ba52c7c7565c059a3f8d7e90');
INSERT INTO _bb_migrations VALUES(60,1791296030236,'a16a7e304e08c8f2c6b0ddec67ec5cf068a496d0e354982d16a34a041a503cb3');
INSERT INTO _bb_migrations VALUES(61,1791296030236,'772122d9ee55dc94eaa9bac4095ba33e13a872f608e09873d1ed946a818a734f');
INSERT INTO _bb_migrations VALUES(62,1791296030237,'3023291f280dc4a7d9ccbebb4520836c5d116d4f52766d1dcc06e7612792cf2f');
INSERT INTO _bb_migrations VALUES(63,1791328166985,'1adc38b42410be2449615bca447811963176890079b074a2b060204bf2a77bf6');
INSERT INTO _bb_migrations VALUES(64,1791328166985,'14c1de81dbe60bb6cc641b7e7c9e4b0dd46be5f0ab4e9e4701ffadb74e686997');
INSERT INTO _bb_migrations VALUES(65,1791328898149,'b3adfd0b80506aec540cfe97159aadc9e672b8f77bed008098714117428f1949');
INSERT INTO _bb_migrations VALUES(66,1791328898149,'63b6fb8745fe4d68c03556d43765c1d398326f57e7b3c4230076c6a0e577b4bf');
INSERT INTO _bb_migrations VALUES(67,1791332636770,'3c22b5ead7622facce023eba6d6f13c44a88e6a9695f9a31814c9dc1b685a0d5');
INSERT INTO _bb_migrations VALUES(68,1791332636770,'0535b7c0f269a88ea05026de993e5978cc83ec43779a03a8f542e5ab3d2f769b');
INSERT INTO _bb_migrations VALUES(69,1791358594485,'f5c5c07acd3672ade9ff721e72ff48f8ab05ee880c582af076d53a32e93b2383');
INSERT INTO _bb_migrations VALUES(70,1791375628741,'7ba4713a43e2d377bbaaf5003bd158e380fde83532b1d37d236db79be7572c8f');
INSERT INTO _bb_migrations VALUES(71,1791394666105,'7187ec69321f693a2b924d12c58cd056a332cb0d2b42310f4472d7318e066fd2');
INSERT INTO _bb_migrations VALUES(72,1791457779671,'6026d3624550280dba3d01b78b235901f983dcdab5752081e3b72033f70bcb1f');
INSERT INTO _bb_migrations VALUES(73,1791457779671,'6db5737af72ba65f9a55e50ef49a4d2ae4ba1ee0f5b04e21798c7beb94a40700');
INSERT INTO _bb_migrations VALUES(74,1791457779671,'f0b237145a49f49bfd1cef05128adbc9ad2cd35266113ccbd1fa295990a01216');
INSERT INTO _bb_migrations VALUES(75,1791457779671,'4ba620b78915ceca99038dd3e0b7c5bf78eaf2268e2a4a6ebec65d95049f953e');
INSERT INTO _bb_migrations VALUES(76,1791457779671,'b6a620260d8be8411d03b568808398dcb225ede616e1c83a4af58e99043d3d36');
INSERT INTO _bb_migrations VALUES(77,1791468310465,'0bbdf5df82c795a61618bc6ca05e88b4fee5f2531978647b4975c066cc441b99');
INSERT INTO _bb_migrations VALUES(78,1791468310465,'eedffbd0b20e60e2586abee963b7bf7f6c56f5d5dd768992699eaa1a872735d1');
INSERT INTO _bb_migrations VALUES(79,1791468310465,'429790de51dc4fb6cb1d9db8a6e49e583e01744691618066f970cbcc7c597545');
INSERT INTO _bb_migrations VALUES(80,1791468441114,'37f49a2c47297835322788e4311896443aaf5a3e378b776bd678915806cda6c7');
INSERT INTO _bb_migrations VALUES(81,1791478795418,'7ee49615834da3a59e770e24f7f6570dffd55f6daa3c4dc332d88e6f9ed721b3');
INSERT INTO _bb_migrations VALUES(82,1791478795418,'8909295c2fce723d3134e5a04b043326904e7484434fcd63ad458242b881dd0a');
INSERT INTO _bb_migrations VALUES(83,1791490365109,'1485124e5700fe141d6710b534e923e186f00395f4a057423f367b164a575d94');
INSERT INTO _bb_migrations VALUES(84,1791666426324,'3d71094533bb882183e4752ee8a174c591048cf2f9c54b63b40be4d75e056fb0');
INSERT INTO _bb_migrations VALUES(85,1791730038673,'9491484c2c79ed9051b0eaa9803fd510fcbc0fff48940cae0a50a19a808608a9');
INSERT INTO _bb_migrations VALUES(86,1791730038676,'b04960e2ff8b215eb86dc21dba38018d2ab5c1a0fa7b4c4a33ede143651567e7');
