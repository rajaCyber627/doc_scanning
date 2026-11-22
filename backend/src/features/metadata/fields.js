// Standard HR metadata fields (RFP pp. 9–10) shared by every document type. Document
// types add their own fields (taxonomy) and may make base fields required.
const CONFIDENTIALITY = ['General', 'Confidential', 'Restricted'];
const RECORD_STATUS = ['Active', 'Final', 'Draft', 'Inactive'];

const BASE_FIELDS = [
  { key: 'documentType', label: 'Document type', type: 'doctype', required: true },
  { key: 'person', label: 'Employee / applicant', type: 'person', required: true },
  { key: 'effectiveDate', label: 'Effective date', type: 'date', required: false },
  { key: 'creationDate', label: 'Document date', type: 'date', required: false },
  { key: 'fiscalYear', label: 'Fiscal year', type: 'fiscalyear', required: false, help: 'Filled from the effective or document date' },
  { key: 'confidentialityLevel', label: 'Confidentiality', type: 'select', options: CONFIDENTIALITY, required: true },
  { key: 'retentionCategory', label: 'Retention category', type: 'text', required: false },
  { key: 'hrFunctionalArea', label: 'HR functional area', type: 'text', required: false },
  { key: 'status', label: 'Record status', type: 'select', options: RECORD_STATUS, required: false },
  { key: 'caseNumber', label: 'Case number', type: 'text', required: false },
  { key: 'positionNumber', label: 'Position number', type: 'text', required: false },
];

// Filled together when a person is picked (or typed in manually).
const PERSON_FIELDS = ['personId', 'personType', 'employeeName', 'employeeId', 'applicantNumber', 'positionTitle', 'department', 'division'];

// Keys set by the system (never by the metadata form) that must survive edits.
const SYSTEM_KEYS = ['email', 'sourcePath', 'recordCategory', 'recordCategoryKey'];

const FIELD_TYPES = ['text', 'number', 'date', 'fiscalyear', 'select', 'person', 'doctype'];

module.exports = { BASE_FIELDS, PERSON_FIELDS, SYSTEM_KEYS, CONFIDENTIALITY, RECORD_STATUS, FIELD_TYPES };
