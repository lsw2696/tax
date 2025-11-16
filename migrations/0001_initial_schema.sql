-- 사업자 정보 테이블
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_number TEXT UNIQUE NOT NULL,  -- 사업자등록번호
  company_name TEXT NOT NULL,            -- 회사명
  ceo_name TEXT NOT NULL,                -- 대표자명
  company_type TEXT NOT NULL CHECK(company_type IN ('중소기업', '중견기업', '대기업')),
  industry TEXT NOT NULL,                -- 업종
  location TEXT NOT NULL,                -- 소재지
  is_capital_area INTEGER DEFAULT 1,     -- 수도권 여부 (1: 수도권, 0: 지방)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 고용 정보 테이블
CREATE TABLE IF NOT EXISTS employment_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,                 -- 과세연도
  total_employees INTEGER DEFAULT 0,     -- 총 상시근로자 수
  employee_increase INTEGER DEFAULT 0,   -- 전년 대비 증가 인원
  youth_employees INTEGER DEFAULT 0,     -- 청년(15-34세) 정규직 수
  disabled_employees INTEGER DEFAULT 0,  -- 장애인 근로자 수
  career_break_women INTEGER DEFAULT 0,  -- 경력단절여성 재고용 수
  total_salary REAL DEFAULT 0,           -- 연간 총급여액
  insurance_paid REAL DEFAULT 0,         -- 사회보험료 납부액
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 투자 정보 테이블
CREATE TABLE IF NOT EXISTS investment_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  facility_type TEXT NOT NULL,           -- 시설 종류
  investment_amount REAL NOT NULL,       -- 투자 금액
  description TEXT,                      -- 투자 설명
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 연구개발 정보 테이블
CREATE TABLE IF NOT EXISTS rnd_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  rnd_type TEXT NOT NULL,                -- 연구개발 유형 (일반/신성장동력/디자인/신기술)
  expense_amount REAL NOT NULL,          -- 연구개발비
  personnel_count INTEGER DEFAULT 0,     -- 연구전담인력 수
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 기타 정보 테이블 (창업, 기부금 등)
CREATE TABLE IF NOT EXISTS other_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  data_type TEXT NOT NULL,               -- 데이터 유형 (창업정보, 기부금, 차량비용 등)
  data_json TEXT NOT NULL,               -- JSON 형태로 저장
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 판정 결과 테이블
CREATE TABLE IF NOT EXISTS assessment_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  credit_rule_id INTEGER NOT NULL,      -- 세액공제 규칙 ID
  credit_rule_name TEXT NOT NULL,        -- 세액공제명
  is_eligible INTEGER NOT NULL,          -- 적용 가능 여부 (1: 가능, 0: 불가)
  credit_amount REAL DEFAULT 0,          -- 공제 가능액
  reasons TEXT,                          -- 판정 사유
  details_json TEXT,                     -- 상세 계산 내역 (JSON)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 판정 세션 테이블 (전체 판정 이력 관리)
CREATE TABLE IF NOT EXISTS assessment_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  total_credit_amount REAL DEFAULT 0,    -- 총 공제 가능액
  eligible_count INTEGER DEFAULT 0,      -- 적용 가능 항목 수
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_companies_business_number ON companies(business_number);
CREATE INDEX IF NOT EXISTS idx_employment_company_year ON employment_data(company_id, year);
CREATE INDEX IF NOT EXISTS idx_investment_company_year ON investment_data(company_id, year);
CREATE INDEX IF NOT EXISTS idx_rnd_company_year ON rnd_data(company_id, year);
CREATE INDEX IF NOT EXISTS idx_other_company_year ON other_data(company_id, year);
CREATE INDEX IF NOT EXISTS idx_results_company_year ON assessment_results(company_id, year);
CREATE INDEX IF NOT EXISTS idx_sessions_company_year ON assessment_sessions(company_id, year);
