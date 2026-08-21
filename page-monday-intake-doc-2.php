<?php
/**
 * Template Name: Monday Intake Doc Generator
 *
 * POST webhook from monday will send event.pulseId (item id).
 * You can also test manually with ?item_id=123
 */

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    get_header();
}

/* =========================
   CONFIG
========================= */
/*
 * Credentials live in wp-config.php, never in this file. This template sits in
 * the theme, which is readable through the WordPress admin's built-in file
 * editor and is committed to git; wp-config.php is neither -- WordPress refuses
 * to open it in that editor, and it lives outside the theme.
 *
 * Add these two lines to wp-config.php, above the
 * "That's all, stop editing! Happy publishing." comment:
 *
 *     define('BLENDE_MONDAY_API_KEY',        '...');  // monday API token
 *     define('BLENDE_MONDAY_WEBHOOK_SECRET', '...');  // ?secret= in the webhook URL
 */
$MONDAY_API_KEY = defined('BLENDE_MONDAY_API_KEY') ? BLENDE_MONDAY_API_KEY : '';
$WEBHOOK_SECRET = defined('BLENDE_MONDAY_WEBHOOK_SECRET') ? BLENDE_MONDAY_WEBHOOK_SECRET : '';

/*
 * Fail closed if either is missing. An empty $WEBHOOK_SECRET is the dangerous
 * one: hash_equals('', '') is TRUE, so a request with no ?secret= at all would
 * be accepted and the webhook would be wide open.
 */
if ($MONDAY_API_KEY === '' || $WEBHOOK_SECRET === '') {
    http_response_code(500);
    echo 'Monday intake is not configured: define BLENDE_MONDAY_API_KEY and '
       . 'BLENDE_MONDAY_WEBHOOK_SECRET in wp-config.php.';
    exit;
}

$BOARD_ID         = 18399609338;  // <- your Patient Intake board ID
$WORKSPACE_ID     = 14286940;     // <- workspace where docs should be created

/*
 * New patient item destination. The group depends on the appointment answer:
 * a patient who says they already have one is scheduled, so they skip the
 * unscheduled queue and land in NP Intake directly.
 */
$DEST_BOARD_ID = 18403436566;
$DEST_GROUP_ID           = 'group_mm2wbwep'; // Unscheduled Intake (no appointment)
$DEST_GROUP_ID_SCHEDULED = 'group_title';    // NP Intake (has an appointment)

$DEST_FIRST_NAME_COL = 'text_mm5fy9d1';      // First Name (text)
$DEST_LAST_NAME_COL  = 'text_mm5f5w6m';      // Last Name (text)
$DEST_EMAIL_COL      = 'email_mm5az59s';     // Patient Email (email)
$DEST_DECISION_COL   = 'long_text_mm5ekv0a'; // Decision Makers (long_text)
$DEST_LOCATION_COL   = 'color_mm5e1zwx';     // Location (status)
$DEST_IDENTIFY_COL   = 'color_mm5frwct';     // Identify As (status)
$DEST_XRAYS_COL      = 'color_mm5fdxvj';     // X-rays (status)
$DEST_XRAYS_INFO_COL = 'long_text_mm5fhcga'; // X-rays more info (long_text)
$DEST_APPT_DATE_COL  = 'date_mm5xm99g';      // Initial Appointment Date (date only)
$DEST_APPT_TIME_COL  = 'hour_mm6a44';        // Initial Appointment Time (hour)
$DEST_STATUS_COL     = 'status';             // Status (status)

/*
 * The Status column defaults to "Scheduled" on the board, which is what an NP
 * Intake patient should start on — so that route writes nothing and lets the
 * default stand. Writing it explicitly would emit a status-changed-to-Scheduled
 * event, and the NP Intake rule listening for that clears the item's pending
 * scheduled actions — including the ones the entry rule had just queued.
 *
 * Unscheduled Intake patients are not scheduled, so they do need the default
 * overridden. Neither "Unscheduled" nor "Schedule Later" matches an
 * item_column_changed rule scoped to Unscheduled Intake, so writing either is
 * inert as a trigger -- but "Schedule Later" IS read as a condition by the
 * welcome-email rule, which skips the email for those patients. It is written
 * as part of create_item, so it is already on the item by the time the
 * item_entered_group webhook is hydrated.
 */
$DEST_STATUS_UNSCHEDULED    = 'Unscheduled';
$DEST_STATUS_SCHEDULE_LATER = 'Schedule Later';  // label 156 on the Status column

/*
 * Status columns are copied BY LABEL, never by index. The form and the item use
 * different indexes for the same answer — e.g. X-rays is form Y=0,N=1 vs item
 * No=0,Yes=1, exactly inverted, so an index copy would record the opposite of
 * what the patient answered. Labels also differ in wording, hence this map.
 *
 * Both the short and long spellings are accepted, so renaming a form label later
 * (M -> Male) won't silently break the mapping.
 */
$LABEL_ALIASES = [
    'm'     => 'Male',
    'male'  => 'Male',
    'f'     => 'Female',
    'female'=> 'Female',
    'other' => 'Other',
    'y'     => 'Yes',
    'yes'   => 'Yes',
    'n'     => 'No',
    'no'    => 'No',
];

// A label the destination column doesn't define fails the whole mutation, so each
// status column declares exactly what it will accept.
$DEST_LOCATION_LABELS = ['NYC', 'SF', 'NJ'];
$DEST_IDENTIFY_LABELS = ['Female', 'Male', 'Other'];
$DEST_YESNO_LABELS    = ['Yes', 'No'];

// monday rejects a long_text write over 2000 chars, which would fail the whole
// create_item mutation — so clamp rather than lose the item.
$LONG_TEXT_MAX = 2000;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {

    // 1) monday webhook verification handshake (must respond even before auth)
    $raw = file_get_contents('php://input');
    $json = json_decode($raw, true);

    if (is_array($json) && isset($json['challenge'])) {
        header('Content-Type: application/json');
        echo json_encode(['challenge' => $json['challenge']]);
        exit;
    }

    // 2) Now enforce your shared secret for real webhook events
    $secret = $_GET['secret'] ?? '';
    if (!hash_equals($WEBHOOK_SECRET, $secret)) {
        http_response_code(403);
        echo "Forbidden";
        exit;
    }

    // IMPORTANT: keep $json around for later (so we don't read php://input twice)
    $GLOBALS['__MONDAY_WEBHOOK_JSON__'] = $json;
}

/* =========================
   HELPERS
========================= */

function monday_graphql($query, $variables = [])
{
    global $MONDAY_API_KEY;

    $payload = json_encode([
        'query' => $query,
        'variables' => $variables
    ]);

    $ch = curl_init('https://api.monday.com/v2');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Authorization: ' . $MONDAY_API_KEY
    ]);

    $resp = curl_exec($ch);
    if ($resp === false) {
        throw new Exception('cURL error: ' . curl_error($ch));
    }
    curl_close($ch);

    $data = json_decode($resp, true);
    if (!is_array($data)) {
        throw new Exception('Invalid JSON from monday: ' . $resp);
    }
    if (!empty($data['errors'])) {
        throw new Exception('Monday API error: ' . print_r($data['errors'], true));
    }
    return $data['data'] ?? [];
}

function norm($s) {
    $s = is_string($s) ? trim($s) : '';
    return $s;
}

function has_value($s) {
    return norm($s) !== '';
}

/**
 * long_text columns cap at 2000 chars; trim to fit so an over-long answer
 * doesn't fail the create_item mutation outright. The full text is still in the doc.
 */
function long_text_value($s) {
    global $LONG_TEXT_MAX;

    $s = norm($s);
    if (mb_strlen($s) > $LONG_TEXT_MAX) {
        $s = mb_substr($s, 0, $LONG_TEXT_MAX - 1) . '…';
    }
    return ['text' => $s];
}

/**
 * Translate a form status label into a destination status value.
 * Returns null (column left unset) when there's nothing safe to write.
 *
 * $default is used when the form answer is blank — e.g. an unchecked
 * "Appointment?" box is recorded as "No" rather than left empty.
 */
function status_label_value($raw, $allowedLabels, $default = '', $colTitle = '')
{
    global $LABEL_ALIASES;

    $raw   = norm($raw);
    $label = '';

    if ($raw !== '') {
        $label = $LABEL_ALIASES[strtolower($raw)] ?? $raw;
    } elseif ($default !== '') {
        $label = $default;
    }

    if ($label === '') {
        return null;
    }

    if (!in_array($label, $allowedLabels, true)) {
        error_log("monday intake: unknown label '$raw' for $colTitle — column left empty on item.");
        return null;
    }

    return ['label' => $label];
}

/**
 * True when a Y/N form answer reads as yes. Anything else — "N", an unexpected
 * answer, or a blank — is treated as no, so an unanswered question never routes
 * a patient as though they were already scheduled.
 */
function is_yes($raw)
{
    global $LABEL_ALIASES;

    return ($LABEL_ALIASES[strtolower(norm($raw))] ?? '') === 'Yes';
}

/**
 * True when the appointment answer is the third option, "Schedule Later" -- the
 * patient intends to book but hasn't yet. Routing-wise they are the same as a
 * plain "No" (both wait in Unscheduled Intake); the difference is only the
 * Status label written on the item, which suppresses the welcome email.
 */
function is_schedule_later($raw)
{
    return strtolower(norm($raw)) === 'schedule later';
}

/**
 * Build the two destination appointment values — a date column that holds only
 * the day, and an Hour column that holds only the time — from the form's two
 * separate answers: "Appointment Date" (a date column with its time picker off)
 * and "Appointment Time" (an Hour column).
 *
 * Returns ['date' => value|null, 'time' => value|null]; either half can be null,
 * since both questions are optional and a patient may answer only one.
 *
 * The two halves are read from opposite places, for the same underlying reason:
 *
 * - Date, from the rendered `text` and not `value`. A monday date column stores an
 *   absolute instant in UTC, so a cell that still carries a time (a legacy row, or
 *   the form's time picker switched back on) reports the wrong day for anything
 *   late in the evening. `text` is that instant rendered back in the account's
 *   timezone, which is the day everyone involved is talking about.
 * - Time, from `value` (`{"hour":16,"minute":5}`) and not `text`. An Hour column
 *   carries no timezone at all, so its value is exactly what the patient picked;
 *   `text` merely formats it through the account's 12/24-hour setting, which would
 *   put that setting in charge of every appointment time we send out.
 *
 * That separation is the whole point: with the time in an Hour column it says
 * 4:05 PM to everyone, regardless of the timezone of the browser that booked it
 * or of whoever reads it afterwards.
 *
 * Each half has a fallback so no answer is silently dropped if a cell comes back
 * in an unexpected shape: the date falls back to `value`, and the time to the Hour
 * column's `text`, then to a time still embedded in the date answer.
 */
function appointment_datetime_values($dateText, $dateRaw, $hourText, $hourRaw)
{
    $out = ['date' => null, 'time' => null];

    // Date half. A trailing time is legacy-only now, but still worth keeping as
    // a last-resort source for the time half below.
    $embeddedTime = null;
    if (has_value($dateText) && preg_match('/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/', trim($dateText), $m)) {
        $out['date'] = ['date' => $m[1]];
        if (isset($m[2])) {
            $embeddedTime = ['hour' => (int)$m[2], 'minute' => (int)$m[3]];
        }
    } elseif (has_value($dateRaw)) {
        $v = json_decode($dateRaw, true);
        if (is_array($v) && !empty($v['date'])) {
            $out['date'] = ['date' => $v['date']];
        }
    }

    // Time half. The Hour answer wins whenever it is filled in.
    $out['time'] = hour_column_value($hourText, $hourRaw);
    if ($out['time'] === null) {
        $out['time'] = $embeddedTime;
    }

    return $out;
}

/**
 * The ['hour' => H, 'minute' => M] a monday Hour column holds, or null when it is
 * empty. `value` is authoritative; `text` ("04:05 PM", or "16:05" on a 24-hour
 * account) is only parsed when the JSON is missing or malformed.
 */
function hour_column_value($text, $rawJson)
{
    if (has_value($rawJson)) {
        $v = json_decode($rawJson, true);
        if (is_array($v) && isset($v['hour']) && is_numeric($v['hour'])) {
            $minute = (isset($v['minute']) && is_numeric($v['minute'])) ? (int)$v['minute'] : 0;
            return ['hour' => (int)$v['hour'], 'minute' => $minute];
        }
    }

    if (has_value($text) && preg_match('/^(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?[Mm])?/', trim($text), $m)) {
        $hour = (int)$m[1];
        if (isset($m[3])) {
            $hour = $hour % 12;                              // 12 AM is hour 0,
            if (strtolower($m[3]) === 'p') { $hour += 12; }  // 12 PM is hour 12.
        }
        if ($hour <= 23) {
            return ['hour' => $hour, 'minute' => (int)$m[2]];
        }
    }

    return null;
}

function format_phone($phone) {
    $digits = preg_replace('/\D+/', '', $phone);

    if (strlen($digits) === 10) {
        return '(' . substr($digits, 0, 3) . ') ' .
               substr($digits, 3, 3) . '-' .
               substr($digits, 6);
    }

    if (strlen($digits) === 11 && $digits[0] === '1') {
        return '(' . substr($digits, 1, 3) . ') ' .
               substr($digits, 4, 3) . '-' .
               substr($digits, 7);
    }

    // fallback if weird length
    return $phone;
}

/**
 * Create the patient item.
 * $columnValues is a map of destination column id => value, already in monday's
 * per-column-type shape. Pass it in the same mutation as the item so the values
 * exist the moment the item does.
 *
 * $groupId picks the destination group; it falls back to the unscheduled queue
 * so a caller that can't determine one never drops the patient off the board.
 */
function create_patient_item($patientFullName, $columnValues = [], $groupId = '')
{
    global $DEST_BOARD_ID, $DEST_GROUP_ID;

    if (!has_value($groupId)) {
        $groupId = $DEST_GROUP_ID;
    }

    $patientFullName = norm($patientFullName);

    if (!has_value($patientFullName)) {
        $patientFullName = 'New Patient Intake';
    }

    $mutation = <<<'GQL'
mutation($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON) {
  create_item(
    board_id: $boardId,
    group_id: $groupId,
    item_name: $itemName,
    column_values: $columnValues
  ) {
    id
    name
  }
}
GQL;

    return monday_graphql($mutation, [
        'boardId'      => (string)$DEST_BOARD_ID,
        'groupId'      => $groupId,
        'itemName'     => $patientFullName,
        // cast to object so an empty map encodes as {} rather than []
        'columnValues' => json_encode((object)$columnValues),
    ]);
}

function add_doc_url_comment_to_item($itemId, $docUrl)
{
    $itemId = (string)$itemId;
    $docUrl = norm($docUrl);

    if (!has_value($itemId) || !has_value($docUrl)) {
        return null;
    }

    $safeDocUrl = htmlspecialchars($docUrl, ENT_QUOTES);
    $body = 'Intake document: <a href="' . $safeDocUrl . '" target="_blank">Open document</a>';

    $mutation = <<<'GQL'
mutation($itemId: ID!, $body: String!) {
  create_update(
    item_id: $itemId,
    body: $body
  ) {
    id
  }
}
GQL;

    return monday_graphql($mutation, [
        'itemId' => $itemId,
        'body'   => $body,
    ]);
}

/**
 * Build Quill delta ops:
 * - If $text is string: returns ops with that text
 * - If $text is array: assumed already ops
 */
function ops_text($text, $bold = false)
{
    if (is_array($text)) return $text;
    $text = (string)$text;
    if ($bold) {
        return [[ 'insert' => $text, 'attributes' => ['bold' => true] ]];
    }
    return [[ 'insert' => $text ]];
}

/**
 * Create a normal_text block inside a table cell.
 * $ops is deltaFormat ops array (no automatic newlines).
 */
function write_cell($docId, $parentCellId, $ops)
{
    if (is_string($ops)) {
        $ops = [[ 'insert' => $ops ]];
    }

    $mutation = <<<'GQL'
mutation($docId: ID!, $parentId: String!, $content: JSON!) {
  create_doc_block(
    doc_id: $docId,
    parent_block_id: $parentId,
    type: normal_text,
    content: $content
  ) { id }
}
GQL;

    $content = [ 'deltaFormat' => $ops ];

    monday_graphql($mutation, [
        'docId'    => $docId,
        'parentId' => $parentCellId,
        'content'  => json_encode($content),
    ]);
}

/**
 * Builds a line "Label: Value" where BOTH label and value are bold.
 */
function ops_bold_label_value($label, $value, $sep = ': ')
{
    return [
        [ 'insert' => $label . $sep, 'attributes' => ['bold' => true] ],
        [ 'insert' => $value,        'attributes' => ['bold' => true] ],
    ];
}

/**
 * Builds a line "Label: Value" where label is bold, value normal.
 */
function ops_bold_label_normal_value($label, $value, $sep = ': ')
{
    return [
        [ 'insert' => $label . $sep, 'attributes' => ['bold' => true] ],
        [ 'insert' => $value ],
    ];
}

/* =========================
   GET ITEM ID
========================= */
$itemId = null;

// manual test
if (!empty($_GET['item_id'])) {
    $itemId = (int)$_GET['item_id'];
}

// webhook post
if (!$itemId) {
    $json = $GLOBALS['__MONDAY_WEBHOOK_JSON__'] ?? null;

    if (!is_array($json)) {
        $raw = file_get_contents('php://input');
        $json = json_decode($raw, true);
    }

    if (is_array($json) && isset($json['event']['pulseId'])) {
        $itemId = (int)$json['event']['pulseId'];
    }
    // some setups post as form fields:
    if (!$itemId && isset($_POST['event']['pulseId'])) {
        $itemId = (int)$_POST['event']['pulseId'];
    }
}

if (!$itemId) {
    echo "<pre>Could not determine item_id.</pre>";
    get_footer();
    exit;
}

/* =========================
   LOAD ITEM + COLUMN VALUES
========================= */
$qItem = <<<'GQL'
query($itemId: ID!) {
  items(ids: [$itemId]) {
    id
    name
    column_values {
      id
      text
      value
    }
  }
}
GQL;

$itemData = monday_graphql($qItem, ['itemId' => (string)$itemId]);
$item = $itemData['items'][0] ?? null;
if (!$item) {
    echo "<pre>Item not found: $itemId</pre>";
    get_footer();
    exit;
}

// Build id => text map, plus id => raw value JSON for the columns whose rendered
// text is lossy (checkbox state, date+time).
$col    = [];
$colVal = [];
foreach (($item['column_values'] ?? []) as $cv) {
    $col[$cv['id']]    = $cv['text'] ?? '';
    $colVal[$cv['id']] = $cv['value'] ?? '';
}

/* DUMP COLUMN KEYS */
/*echo '<pre>';
foreach ($col as $id => $value) {
    echo $id . " => ";
    print_r($value);
    echo "\n\n";
}
echo '</pre>';
exit;*/ 


/* =========================
   MAP YOUR FIELDS (use your IDs)
========================= */
// From your mapping list:
$firstName        = norm($col['short_textwo7phq0g'] ?? '');
$lastName         = norm($col['short_textmrih0sp7'] ?? '');
$fullName         = trim(($firstName ? $firstName : '') . ($lastName ? ' ' . $lastName : ''));

$address1         = norm($col['short_texty0bmba6r'] ?? '');
$address2         = norm($col['short_texta3mkupdv'] ?? '');
$city             = norm($col['short_textmwy1rlrf'] ?? '');
$state            = norm($col['short_textnn2a5k1i'] ?? '');
$zip              = norm($col['short_textvkxqthp7'] ?? '');

$email            = norm($col['short_textvxnp3h5e'] ?? '');

$mobile           = norm($col['phonecbmmbtbc'] ?? '');
$homePhone        = norm($col['phone3c9xrp74'] ?? '');
$workPhone        = norm($col['phoneeqf5h3h6'] ?? '');

$birthdate        = norm($col['datep282i55e'] ?? '');
$age              = norm($col['number3nb1fw6d'] ?? '');
$gender           = norm($col['single_selecto1o86gu'] ?? '');
$height           = norm($col['short_textrixlffjf'] ?? '');
$weight           = norm($col['short_textbz6g4zun'] ?? '');

$chiefComplaint   = norm($col['long_textp12izog2'] ?? '');

$medConditions    = norm($col['long_text7t6qvph2'] ?? '');

$ambulatory       = norm($col['single_selectmdz0h88'] ?? '');
$ambulatoryDesc   = norm($col['short_textx18vih50'] ?? '');

$dentalConditions = norm($col['long_textcmyxiw5o'] ?? '');

$xrayRequested    = norm($col['single_selectmzye6nk'] ?? '');
$xrayDetails      = norm($col['short_texthpae0vgf'] ?? '');

$othersInvolved   = norm($col['long_textnjkgxxnz'] ?? '');

$residenceType    = norm($col['short_text1ih0lfoe'] ?? '');
$stairsInfo       = norm($col['short_textjxtdaavs'] ?? '');

$decisionMakers   = norm($col['long_textqqujk9v7'] ?? '');
$resourcesFee     = norm($col['long_textd4tcpvhc'] ?? '');

$refType          = norm($col['single_selectp541axx'] ?? '');
$refDetail        = norm($col['short_textjuuyos9n'] ?? '');
$refPhone         = norm($col['phonex7q7ko8r'] ?? '');
$refCity          = norm($col['short_texttt2zwll8'] ?? '');
$department       = norm($col['single_selectt7jawe5'] ?? '');

$pharmacy         = norm($col['short_textg9uvlcm8'] ?? '');

$miscNotes        = norm($col['long_text63eyi3b7'] ?? '');

$likelyPatient    = norm($col['single_select6ftval6'] ?? '');

// Allergies / meds group
$drugAllergies    = norm($col['single_select41h5n62'] ?? '');
$whichDrugAll     = norm($col['short_textqdzuaajf'] ?? '');

$glp1             = norm($col['single_selects3i98rw'] ?? '');
$whichGlp1        = norm($col['short_texthaeljkas'] ?? '');

$anticoag         = norm($col['single_select7uv8jeu'] ?? '');
$whichAnticoag    = norm($col['short_text01mzse6a'] ?? '');

$bisphos          = norm($col['single_selectcl76k9n'] ?? '');
$whichBisphos     = norm($col['short_textuljyia03'] ?? '');

$abxProph         = norm($col['single_selecto55cjkd'] ?? '');
$whichAbxProph    = norm($col['short_textxlwelj8s'] ?? '');

$medicationMisc = norm($col['short_text6omb9t3b'] ?? '');

$submittedBy = norm($col['single_selectjez0ixb'] ?? '');

$location = norm($col['single_selectxd9bsrd'] ?? ''); // status column — .text is the label

/*
 * Appointment: the form's "Appointment?" question actually writes to
 * single_selectn732562 (a Y/N status still titled "Single select" on the board),
 * NOT to the checkbox column titled "Appointment?" — that one stays unchecked on
 * every submission. Confirmed against live form answers; don't "fix" this to the
 * checkbox on the strength of the column titles.
 */
$hasAppointment = norm($col['single_selectn732562'] ?? '');

/*
 * Date and time are two separate form questions in two separate columns:
 * "Appointment Date" (datepwp1q8hp, a date column whose time picker is turned
 * off) and "Appointment Time" (hourt4d7dyjt, an Hour column). Both are titled
 * generically on the board — "Appointment Date/Time" and "Hour" — so go by the
 * form's question text, not the column title.
 */
$apptDateText   = $col['datepwp1q8hp'] ?? '';
$apptDateRaw    = $colVal['datepwp1q8hp'] ?? '';
$apptTimeText   = $col['hourt4d7dyjt'] ?? '';
$apptTimeRaw    = $colVal['hourt4d7dyjt'] ?? '';


/* =========================
   BUILD DOC TITLE (Department + Patient)
========================= */
$titleParts = [];

// Name first
$titleParts[] = has_value($fullName) ? $fullName : ($item['name'] ?? 'Intake');

// Department second (only if present)
if (has_value($department)) {
    $titleParts[] = "Department: " . $department;
}

$docTitle = implode(" — ", $titleParts);


/* =========================
   CREATE DOC
   IMPORTANT: Pull id, object_id, and url directly from monday.
========================= */
$createDoc = <<<'GQL'
mutation($workspaceId: ID!, $name: String!) {
  create_doc(
    location: {
      workspace: {
        workspace_id: $workspaceId
        name: $name
        kind: public
      }
    }
  ) {
    id
    object_id
    url
  }
}
GQL;

$docData = monday_graphql($createDoc, [
  'workspaceId' => $WORKSPACE_ID,
  'name'        => $docTitle,
]);

$docId = $docData['create_doc']['id'];
$docObjectId = $docData['create_doc']['object_id'] ?? '';
$docUrl = $docData['create_doc']['url'] ?? '';

/* =========================
   CREATE TABLE (3 columns: label/content/buffer)
   AUTO-HIDE EMPTY ROWS: build rows first, then set row_count.
========================= */

// Build Name cell ops (with paragraph breaks + Age bold)
$nameOps = [];
$nameOps[] = [ 'insert' => (has_value($fullName) ? $fullName : ($item['name'] ?? '')), 'attributes' => ['bold' => true] ];
$nameOps[] = [ 'insert' => "\n" ];

$addrBits = [];
$line12 = trim($address1 . ' ' . $address2);
if (has_value($line12)) $addrBits[] = $line12;
$csz = trim($city . ($city && $state ? ', ' : ' ') . $state . ' ' . $zip);
if (has_value($csz)) $addrBits[] = $csz;
if (!empty($addrBits)) {
    $nameOps[] = [ 'insert' => implode(' ', $addrBits) . "\n" ];
}

$phoneLine = [];
if (has_value($homePhone))  $phoneLine[] = "Home: " . format_phone($homePhone);
if (has_value($mobile))    $phoneLine[] = "Mobile: " . format_phone($mobile);
if (has_value($workPhone)) $phoneLine[] = "Work: " . format_phone($workPhone);
if (!empty($phoneLine)) {
    $nameOps[] = [ 'insert' => implode("   ", $phoneLine) . "\n", 'attributes' => ['bold' => true] ];
}

if (has_value($email)) {
    $nameOps[] = [ 'insert' => "Email: $email\n\n" ];
}

// -------------------------------
// Demographics line (conditional)
// -------------------------------
$demoOps = [];
$sep = " • ";

// Birthdate (normal)
if (has_value($birthdate)) {
    $demoOps[] = [ 'insert' => "Birthdate: $birthdate" ];
}

// Age (bold label + value)
if (has_value($age)) {
    if (!empty($demoOps)) {
        $demoOps[] = [ 'insert' => $sep ];
    }
    $demoOps[] = [ 'insert' => "Age: $age", 'attributes' => ['bold' => true] ];
}

// Gender
if (has_value($gender)) {
    if (!empty($demoOps)) {
        $demoOps[] = [ 'insert' => $sep ];
    }
    $demoOps[] = [ 'insert' => "Gender: $gender" ];
}

// Height
if (has_value($height)) {
    if (!empty($demoOps)) {
        $demoOps[] = [ 'insert' => $sep ];
    }
    $demoOps[] = [ 'insert' => "Height: $height" ];
}

// Weight
if (has_value($weight)) {
    if (!empty($demoOps)) {
        $demoOps[] = [ 'insert' => $sep ];
    }
    $demoOps[] = [ 'insert' => "Weight: $weight" ];
}

if (!empty($demoOps)) {
    // Only add a paragraph break if we didn't just add one
    $lastInsert = '';
    for ($i = count($nameOps) - 1; $i >= 0; $i--) {
        if (isset($nameOps[$i]['insert'])) { $lastInsert = $nameOps[$i]['insert']; break; }
    }
    if (substr($lastInsert, -2) !== "\n\n") {
        $nameOps[] = [ 'insert' => "\n\n" ];
    }

    foreach ($demoOps as $op) {
        $nameOps[] = $op;
    }
}



// Rows array: each entry is [labelText, opsArrayForRightCell]
$rows = [];

// Submitted By (only if filled)
if (has_value($submittedBy)) {
    $rows[] = ["Submitted By", [[ 'insert' => $submittedBy ]]];
}

// Add row only if right-side has meaningful content
$rows[] = ["Name", $nameOps];

if (has_value($chiefComplaint)) {
    $rows[] = ["Chief complaint", [[ 'insert' => $chiefComplaint ]]];
}

// Medical row: include ambulatory line only if present
$medOps = [];
if (has_value($medConditions)) {
    $medOps[] = [ 'insert' => $medConditions ];
}
$ambLine = [];
if (has_value($ambulatory)) {
    // paragraph break if there was medConditions
    if (!empty($medOps)) $medOps[] = [ 'insert' => "\n\n" ];

    // BOTH label + response bold
    $medOps = array_merge($medOps, ops_bold_label_value("Ambulatory?", $ambulatory));
    if (has_value($ambulatoryDesc)) {
        $medOps[] = [ 'insert' => " • " . $ambulatoryDesc, 'attributes' => ['bold' => true] ];
    }
}
if (!empty($medOps)) {
    $rows[] = ["Medical condition", $medOps];
}

if (has_value($othersInvolved)) {
    $rows[] = ["Others involved", [[ 'insert' => $othersInvolved ]]];
}

// Dental row: include x-ray line only if present
$dentOps = [];
if (has_value($dentalConditions)) {
    $dentOps[] = [ 'insert' => $dentalConditions ];
}
if (has_value($xrayRequested)) {
    if (!empty($dentOps)) $dentOps[] = [ 'insert' => "\n\n" ];

    // BOTH label + response bold
    $dentOps = array_merge($dentOps, ops_bold_label_value("X-rays requested?", $xrayRequested));
    if (has_value($xrayDetails)) {
        $dentOps[] = [ 'insert' => " • X-ray details: " . $xrayDetails, 'attributes' => ['bold' => true] ];
    }
}
if (!empty($dentOps)) {
    $rows[] = ["Dental condition", $dentOps];
}

// Allergies & meds row: include only sub-lines that have answers.
// AND: for these bolded labels, make responses bold too (per your screenshot).
$allOps = [];
$addAllLine = function($label, $val, $detail = '') use (&$allOps) {
    if (!has_value($val) && !has_value($detail)) return;

    $value = trim($val . (has_value($detail) ? " $detail" : ''));
    $allOps = array_merge($allOps, ops_bold_label_value($label, $value));
    $allOps[] = [ 'insert' => "\n" ];
};

$addAllLine("Drug allergies", $drugAllergies, $whichDrugAll);
$addAllLine("GLP-1", $glp1, $whichGlp1);
$addAllLine("Anticoagulants", $anticoag, $whichAnticoag);
$addAllLine("Bisphosphonates", $bisphos, $whichBisphos);
$addAllLine("Abx prophylaxis", $abxProph, $whichAbxProph);
$addAllLine("Medication misc", $medicationMisc);

// remove trailing extra paragraph break
if (!empty($allOps)) {
    $last = end($allOps);
    if (isset($last['insert']) && $last['insert'] === "\n\n") {
        array_pop($allOps);
    }
    $rows[] = ["Allergies & meds", $allOps];
}

// Residence
$resText = trim($residenceType . (has_value($stairsInfo) ? "   " . $stairsInfo : ""));
if (has_value($resText)) {
    $rows[] = ["Residence type", [[ 'insert' => $resText ]]];
}

// Legal & Financials (only include if something present)
$finOps = [];
if (has_value($decisionMakers)) {
    $finOps[] = [ 'insert' => "Decision makers: " . $decisionMakers ];
}
if (has_value($resourcesFee)) {
    if (!empty($finOps)) $finOps[] = [ 'insert' => "\n\n" ];
    $finOps[] = [ 'insert' => "Resources / fee discussion: " . $resourcesFee ];
}
if (!empty($finOps)) {
    $rows[] = ["Legal & Financials", $finOps];
}

// Referral info: hide if all empty. Bold labels + responses bold too (per your request for bold items).
$refOps = [];
if (has_value($refType)) {
    $refOps[] = [ 'insert' => "Type: " . $refType ];
    $refOps[] = [ 'insert' => "\n\n" ];
}
$inlineAny = false;
if (has_value($refDetail)) {
    $refOps = array_merge($refOps, ops_bold_label_value("Detail", $refDetail));
    $refOps[] = [ 'insert' => "   " ];
    $inlineAny = true;
}
if (has_value($refPhone)) {
    $refOps = array_merge($refOps, ops_bold_label_value("Phone", format_phone($refPhone)));
    $refOps[] = [ 'insert' => "   " ];
    $inlineAny = true;
}
if (has_value($refCity)) {
    $refOps = array_merge($refOps, ops_bold_label_value("City", $refCity));
    $inlineAny = true;
}
// trim trailing spaces
if (!empty($refOps)) {
    $rows[] = ["Referral info", $refOps];
}

// Pharmacy
if (has_value($pharmacy)) {
    $rows[] = ["Pharmacy", [[ 'insert' => $pharmacy ]]];
}

// Misc notes (include Likely patient? only if it has a value)
$miscOps = [];

if (has_value($miscNotes)) {
    $miscOps[] = [ 'insert' => $miscNotes ];
}

if (has_value($likelyPatient)) {
    if (!empty($miscOps)) $miscOps[] = [ 'insert' => "\n\n" ];
    // If you want it bold like your other bold rows:
    $miscOps = array_merge($miscOps, ops_bold_label_value("Likely patient?", $likelyPatient));
}

if (!empty($miscOps)) {
    $rows[] = ["Misc notes", $miscOps];
}

// If for some reason everything is empty, keep at least 1 row
if (count($rows) === 0) {
    $rows[] = ["Intake", [[ 'insert' => "(No data)" ]]];
}

// Create the table with exactly the needed row count
$rowCount = count($rows);

$createTableBlock = <<<'GQL'
mutation($docId: ID!, $content: JSON!) {
  create_doc_block(
    doc_id: $docId,
    type: table,
    content: $content
  ) {
    id
    content
  }
}
GQL;

$tableContent = [
  'column_count' => 3,
  'row_count'    => $rowCount,
  'column_style' => [ 
      ['width' => 20],
      ['width' => 78],
      ['width' => 2],
  ],
];

$tableData = monday_graphql($createTableBlock, [
    'docId'   => (string)$docId,
    'content' => json_encode($tableContent),
]);

$tableContentJson = $tableData['create_doc_block']['content'] ?? null;
if (!$tableContentJson) {
    throw new Exception('No table content returned from create_doc_block.');
}

$tableContentArr = json_decode($tableContentJson, true);
$cells2d = $tableContentArr['cells'] ?? null;
if (!$cells2d || !is_array($cells2d)) {
    throw new Exception('No table cell data found in table content.');
}

// Flatten 2D array of {blockId} to a row-major list
$cellIds = [];
foreach ($cells2d as $row) {
    if (!is_array($row)) continue;
    foreach ($row as $cellObj) {
        if (isset($cellObj['blockId'])) {
            $cellIds[] = $cellObj['blockId'];
        }
    }
}

// Populate the table
$cell = 0;
foreach ($rows as $r) {
    $label = $r[0];
    $ops   = $r[1];

    $cellLabel  = $cellIds[$cell++] ?? null; // col 1
    $cellValue  = $cellIds[$cell++] ?? null; // col 2
    $cellBuffer = $cellIds[$cell++] ?? null; // col 3 (buffer)

    if ($cellLabel)  write_cell($docId, $cellLabel, [[ 'insert' => $label ]]);
    if ($cellValue)  write_cell($docId, $cellValue, $ops);
    if ($cellBuffer) write_cell($docId, $cellBuffer, " ");
}

// Column values for the new patient item (dest column id => value). Empty values are skipped.
$destColumns = [];

// The item is named with the full name; these keep the parts separately addressable.
if (has_value($firstName)) {
    $destColumns[$DEST_FIRST_NAME_COL] = $firstName;
}

if (has_value($lastName)) {
    $destColumns[$DEST_LAST_NAME_COL] = $lastName;
}

if (has_value($email)) {
    // an email column takes {email, text}, not a bare string; text is the display label
    $destColumns[$DEST_EMAIL_COL] = ['email' => $email, 'text' => $email];
}

// "Medical and financial decision makers" on the form → Decision Makers on the item
if (has_value($decisionMakers)) {
    $destColumns[$DEST_DECISION_COL] = long_text_value($decisionMakers);
}

// Location — matched by label, since the two columns' indexes differ (see config)
$v = status_label_value($location, $DEST_LOCATION_LABELS, '', 'Location');
if ($v !== null) {
    $destColumns[$DEST_LOCATION_COL] = $v;
}

// "How do you identify" → Identify As (M -> Male, F -> Female)
$v = status_label_value($gender, $DEST_IDENTIFY_LABELS, '', 'Identify As');
if ($v !== null) {
    $destColumns[$DEST_IDENTIFY_COL] = $v;
}

// X-rays (Y -> Yes, N -> No). Blank is recorded as "No" per the agreed default.
$v = status_label_value($xrayRequested, $DEST_YESNO_LABELS, 'No', 'X-rays');
if ($v !== null) {
    $destColumns[$DEST_XRAYS_COL] = $v;
}

if (has_value($xrayDetails)) {
    $destColumns[$DEST_XRAYS_INFO_COL] = long_text_value($xrayDetails);
}

/*
 * Appointment Date + Appointment Time → Initial Appointment Date + Initial
 * Appointment Time, each written whenever the patient answered it. This is
 * independent of the routing below: the "Appointment?" answer alone decides the
 * group, and a date without a "yes" is still worth recording.
 */
$appt = appointment_datetime_values($apptDateText, $apptDateRaw, $apptTimeText, $apptTimeRaw);
if ($appt['date'] !== null) {
    $destColumns[$DEST_APPT_DATE_COL] = $appt['date'];
}
if ($appt['time'] !== null) {
    $destColumns[$DEST_APPT_TIME_COL] = $appt['time'];
}

/*
 * A patient who says they have an appointment is already scheduled, so they go
 * straight to NP Intake — including when they left the date blank. Everyone else
 * waits in Unscheduled Intake.
 */
$destGroupId = is_yes($hasAppointment) ? $DEST_GROUP_ID_SCHEDULED : $DEST_GROUP_ID;

/*
 * NP Intake patients are left alone: the board's own default already puts them
 * on "Scheduled" (see the config note above for why we don't write it). Everyone
 * else has no appointment yet, so override the default to "Unscheduled".
 */
if ($destGroupId !== $DEST_GROUP_ID_SCHEDULED) {
    $destColumns[$DEST_STATUS_COL] = [
        'label' => is_schedule_later($hasAppointment)
            ? $DEST_STATUS_SCHEDULE_LATER
            : $DEST_STATUS_UNSCHEDULED,
    ];
}

// Create item in destination board using patient full name
$newPatientItemData = create_patient_item($fullName, $destColumns, $destGroupId);
$newPatientItem = $newPatientItemData['create_item'] ?? null;
$newPatientItemId = $newPatientItem['id'] ?? '';

// Add the real monday document URL as a comment/update on the new patient item
$newPatientCommentData = null;
$newPatientCommentId = '';

if (has_value($newPatientItemId)) {
    $newPatientCommentData = add_doc_url_comment_to_item($newPatientItemId, $docUrl);
    $newPatientCommentId = $newPatientCommentData['create_update']['id'] ?? '';
}

echo "<pre>✅ Created doc successfully."
   . "\nDoc title: " . htmlspecialchars($docTitle)
   . "\nDoc ID: " . htmlspecialchars($docId)
   . "\nDoc Object ID: " . htmlspecialchars($docObjectId)
   . "\nDoc link: " . htmlspecialchars($docUrl)
   . "\nSource Item ID: " . htmlspecialchars($itemId)
   . "\nNew Patient Item ID: " . htmlspecialchars($newPatientItemId)
   . "\nNew Patient Comment ID: " . htmlspecialchars($newPatientCommentId)
   . "</pre>";

get_footer();