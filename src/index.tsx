import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { D1Database } from '@cloudflare/workers-types'
import taxRules from '../tax_rules.json'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())

// 정적 파일 서빙
app.use('/static/*', serveStatic({ root: './' }))

// ==================== API 라우트 ====================

// 1. 세액공제 규칙 조회
app.get('/api/rules', (c) => {
  return c.json({
    success: true,
    data: taxRules
  })
})

// 2. 규칙 상세 조회
app.get('/api/rules/:ruleKey', (c) => {
  const ruleKey = c.req.param('ruleKey')
  const rule = taxRules[ruleKey as keyof typeof taxRules]
  
  if (!rule) {
    return c.json({ success: false, error: '규칙을 찾을 수 없습니다' }, 404)
  }
  
  return c.json({ success: true, data: rule })
})

// 3. 사업자 등록/조회
app.post('/api/companies', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  
  try {
    const { business_number, company_name, ceo_name, company_type, industry, location, is_capital_area } = body
    
    // 중복 체크
    const existing = await DB.prepare('SELECT id FROM companies WHERE business_number = ?')
      .bind(business_number)
      .first()
    
    if (existing) {
      return c.json({
        success: true,
        data: existing,
        message: '이미 등록된 사업자입니다'
      })
    }
    
    // 신규 등록
    const result = await DB.prepare(`
      INSERT INTO companies (business_number, company_name, ceo_name, company_type, industry, location, is_capital_area)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(business_number, company_name, ceo_name, company_type, industry, location, is_capital_area ? 1 : 0).run()
    
    return c.json({
      success: true,
      data: { id: result.meta.last_row_id },
      message: '사업자 등록 완료'
    })
  } catch (error) {
    console.error('사업자 등록 실패:', error)
    return c.json({ success: false, error: '사업자 등록에 실패했습니다' }, 500)
  }
})

// 4. 사업자 조회
app.get('/api/companies/:businessNumber', async (c) => {
  const { DB } = c.env
  const businessNumber = c.req.param('businessNumber')
  
  try {
    const company = await DB.prepare('SELECT * FROM companies WHERE business_number = ?')
      .bind(businessNumber)
      .first()
    
    if (!company) {
      return c.json({ success: false, error: '사업자를 찾을 수 없습니다' }, 404)
    }
    
    return c.json({ success: true, data: company })
  } catch (error) {
    return c.json({ success: false, error: '조회에 실패했습니다' }, 500)
  }
})

// 5. 판정 실행 API
app.post('/api/assess', async (c) => {
  const { DB } = c.env
  const body = await c.req.json()
  
  try {
    const { 
      company_id, 
      year, 
      employmentData, 
      investmentData, 
      rndData, 
      otherData 
    } = body
    
    // 판정 결과 저장용 배열
    const results: any[] = []
    let totalCreditAmount = 0
    let eligibleCount = 0
    
    // 회사 정보 조회
    const company: any = await DB.prepare('SELECT * FROM companies WHERE id = ?')
      .bind(company_id)
      .first()
    
    if (!company) {
      return c.json({ success: false, error: '회사 정보를 찾을 수 없습니다' }, 404)
    }
    
    // 각 규칙별로 판정 실행
    for (const [key, rule] of Object.entries(taxRules)) {
      const assessment = assessRule(rule, {
        company,
        employmentData,
        investmentData,
        rndData,
        otherData
      })
      
      results.push({
        credit_rule_id: rule.id,
        credit_rule_name: rule.name,
        is_eligible: assessment.eligible ? 1 : 0,
        credit_amount: assessment.creditAmount,
        reasons: assessment.reasons,
        details_json: JSON.stringify(assessment.details)
      })
      
      if (assessment.eligible) {
        totalCreditAmount += assessment.creditAmount
        eligibleCount++
      }
    }
    
    // 결과를 DB에 저장
    for (const result of results) {
      await DB.prepare(`
        INSERT INTO assessment_results 
        (company_id, year, credit_rule_id, credit_rule_name, is_eligible, credit_amount, reasons, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        company_id,
        year,
        result.credit_rule_id,
        result.credit_rule_name,
        result.is_eligible,
        result.credit_amount,
        result.reasons,
        result.details_json
      ).run()
    }
    
    // 판정 세션 저장
    const sessionResult = await DB.prepare(`
      INSERT INTO assessment_sessions (company_id, year, total_credit_amount, eligible_count)
      VALUES (?, ?, ?, ?)
    `).bind(company_id, year, totalCreditAmount, eligibleCount).run()
    
    return c.json({
      success: true,
      data: {
        session_id: sessionResult.meta.last_row_id,
        total_credit_amount: totalCreditAmount,
        eligible_count: eligibleCount,
        results
      }
    })
  } catch (error) {
    console.error('판정 실행 실패:', error)
    return c.json({ success: false, error: '판정 실행에 실패했습니다' }, 500)
  }
})

// 6. 판정 결과 조회
app.get('/api/results/:companyId/:year', async (c) => {
  const { DB } = c.env
  const companyId = c.req.param('companyId')
  const year = c.req.param('year')
  
  try {
    const results: any = await DB.prepare(`
      SELECT * FROM assessment_results 
      WHERE company_id = ? AND year = ?
      ORDER BY credit_rule_id
    `).bind(companyId, year).all()
    
    const session: any = await DB.prepare(`
      SELECT * FROM assessment_sessions 
      WHERE company_id = ? AND year = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(companyId, year).first()
    
    return c.json({
      success: true,
      data: {
        session,
        results: results.results
      }
    })
  } catch (error) {
    return c.json({ success: false, error: '결과 조회에 실패했습니다' }, 500)
  }
})

// ==================== 규칙 엔진 로직 ====================

interface AssessmentContext {
  company: any
  employmentData?: any
  investmentData?: any[]
  rndData?: any[]
  otherData?: any
}

interface AssessmentResult {
  eligible: boolean
  creditAmount: number
  reasons: string
  details: any
}

function assessRule(rule: any, context: AssessmentContext): AssessmentResult {
  const { company, employmentData, investmentData, rndData, otherData } = context
  
  // 각 규칙별 판정 로직
  switch (rule.id) {
    case 1: // 고용증대 세액공제
      return assessEmploymentIncrease(rule, company, employmentData)
    case 2: // 청년 정규직 고용 추가 공제
      return assessYouthEmployment(rule, company, employmentData)
    case 3: // 장애인 고용 세액공제
      return assessDisabledEmployment(rule, company, employmentData)
    case 4: // 경력단절여성 재고용 세액공제
      return assessCareerBreakWomen(rule, company, employmentData)
    case 5: // 사회보험료 세액공제
      return assessSocialInsurance(rule, company, employmentData)
    case 6: // 중소기업 특별세액감면
      return assessSmeSpecialReduction(rule, company, otherData)
    case 7: // 창업중소기업 세액감면
      return assessStartupSmeReduction(rule, company, otherData)
    case 8: // 제조업 지방 이전 세액감면
      return assessManufacturingRelocation(rule, company, otherData)
    case 9: // 사회적기업 및 협동조합 세액감면
      return assessSocialEnterpriseReduction(rule, company, otherData)
    case 10: // 청년창업 세액감면
      return assessYouthStartupReduction(rule, company, otherData)
    case 11: // 생산성향상시설 투자 세액공제
      return assessProductivityFacilities(rule, company, investmentData)
    case 12: // 에너지절약·환경개선시설 투자 세액공제
      return assessEnergyEnvironmentFacilities(rule, company, investmentData)
    case 13: // 안전시설 투자 세액공제
      return assessSafetyFacilities(rule, company, investmentData)
    case 14: // 스마트공장 자동화설비 투자 세액공제
      return assessSmartFactory(rule, company, investmentData)
    case 15: // 연구인력개발비 세액공제
      return assessRndExpense(rule, company, rndData)
    case 16: // 디자인 개발비 세액공제
      return assessDesignExpense(rule, company, rndData)
    case 17: // 데이터·AI·IoT 기술 개발비 공제
      return assessNewTechnologyExpense(rule, company, rndData)
    case 18: // 기부금 세액공제
      return assessDonation(rule, company, otherData)
    case 19: // 업무용 차량 비용 한도 검증
      return assessBusinessVehicle(rule, company, otherData)
    default:
      return {
        eligible: false,
        creditAmount: 0,
        reasons: '미구현 규칙',
        details: {}
      }
  }
}

// 1. 고용증대 세액공제
function assessEmploymentIncrease(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.employee_increase || data.employee_increase < 1) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '전년 대비 상시근로자 증가 인원이 없습니다',
      details: { employee_increase: data?.employee_increase || 0 }
    }
  }
  
  const companyType = company.company_type
  const isCapitalArea = company.is_capital_area === 1
  const increase = data.employee_increase
  
  let perPersonCredit = 0
  if (companyType === '중소기업') {
    perPersonCredit = isCapitalArea ? 11000000 : 12000000
  } else if (companyType === '중견기업') {
    perPersonCredit = isCapitalArea ? 9000000 : 10000000
  } else {
    perPersonCredit = isCapitalArea ? 4500000 : 5000000
  }
  
  const totalCredit = perPersonCredit * increase
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `${companyType} ${increase}명 증가, 1인당 ${(perPersonCredit / 10000).toFixed(0)}만원 공제`,
    details: {
      company_type: companyType,
      is_capital_area: isCapitalArea,
      employee_increase: increase,
      per_person_credit: perPersonCredit,
      total_credit: totalCredit
    }
  }
}

// 2. 청년 정규직 고용 추가 공제
function assessYouthEmployment(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.youth_employees || data.youth_employees < 1) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '청년(15-34세) 정규직 근로자 증가가 없습니다',
      details: {}
    }
  }
  
  const companyType = company.company_type
  const youthIncrease = data.youth_employees
  
  let additionalCredit = 0
  if (companyType === '중소기업') {
    additionalCredit = 12000000
  } else if (companyType === '중견기업') {
    additionalCredit = 10000000
  } else {
    additionalCredit = 5000000
  }
  
  const totalCredit = additionalCredit * youthIncrease
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `청년 정규직 ${youthIncrease}명 증가, 1인당 추가 ${(additionalCredit / 10000).toFixed(0)}만원 공제`,
    details: {
      company_type: companyType,
      youth_increase: youthIncrease,
      additional_credit: additionalCredit,
      total_credit: totalCredit
    }
  }
}

// 3. 장애인 고용 세액공제
function assessDisabledEmployment(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.disabled_employees || data.disabled_employees < 1) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '장애인 근로자 고용 실적이 없습니다',
      details: {}
    }
  }
  
  const disabledCount = data.disabled_employees
  const perPersonCredit = 9600000  // 월 80만원 × 12개월
  const totalCredit = perPersonCredit * disabledCount
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `장애인 근로자 ${disabledCount}명, 1인당 연 960만원 공제`,
    details: {
      disabled_count: disabledCount,
      per_person_credit: perPersonCredit,
      total_credit: totalCredit
    }
  }
}

// 4. 경력단절여성 재고용 세액공제
function assessCareerBreakWomen(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.career_break_women || data.career_break_women < 1) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '경력단절여성 재고용 실적이 없습니다',
      details: {}
    }
  }
  
  const count = data.career_break_women
  const perPersonCredit = 11000000
  const totalCredit = perPersonCredit * count
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `경력단절여성 ${count}명 재고용, 1인당 연 1,100만원 공제 (최대 2년)`,
    details: {
      count,
      per_person_credit: perPersonCredit,
      total_credit: totalCredit,
      max_years: 2
    }
  }
}

// 5. 사회보험료 세액공제
function assessSocialInsurance(rule: any, company: any, data: any): AssessmentResult {
  if (company.company_type !== '중소기업') {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '중소기업만 해당됩니다',
      details: {}
    }
  }
  
  if (!data || !data.insurance_paid || data.insurance_paid < 1) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '사회보험료 납부 실적이 없습니다',
      details: {}
    }
  }
  
  const insurancePaid = data.insurance_paid
  const creditRate = 0.25
  const maxPerPerson = 1000000
  
  let totalCredit = insurancePaid * creditRate
  
  // 인당 한도 적용 (신규·청년 근로자 수 기준)
  const newEmployees = (data.employee_increase || 0) + (data.youth_employees || 0)
  const maxCredit = maxPerPerson * newEmployees
  
  if (totalCredit > maxCredit) {
    totalCredit = maxCredit
  }
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `사업주 부담 사회보험료의 25% 공제 (인당 연 100만원 한도)`,
    details: {
      insurance_paid: insurancePaid,
      credit_rate: creditRate,
      new_employees: newEmployees,
      total_credit: totalCredit
    }
  }
}

// 6. 중소기업 특별세액감면
function assessSmeSpecialReduction(rule: any, company: any, data: any): AssessmentResult {
  if (company.company_type !== '중소기업') {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '중소기업만 해당됩니다',
      details: {}
    }
  }
  
  if (!data || !data.business_income) {
    return {
      eligible: false,
      creditAmount: 0,
      reasons: '사업소득 정보가 없습니다',
      details: {}
    }
  }
  
  const industry = company.industry
  const income = data.business_income
  const tax = data.calculated_tax || income * 0.10  // 임시 세액 계산
  
  // 업종별 감면율
  let reductionRate = 0.05  // 기본 5%
  if (['제조업', '광업', '건설업', '도매업', '소매업'].includes(industry)) {
    reductionRate = 0.10  // 10%
  }
  
  const totalCredit = tax * reductionRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `중소기업 특별세액감면 ${(reductionRate * 100).toFixed(0)}% 적용`,
    details: {
      industry,
      business_income: income,
      calculated_tax: tax,
      reduction_rate: reductionRate,
      total_credit: totalCredit
    }
  }
}

// 나머지 함수들 (7-19)도 동일한 패턴으로 구현
function assessStartupSmeReduction(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.startup_date) {
    return { eligible: false, creditAmount: 0, reasons: '창업 정보가 없습니다', details: {} }
  }
  
  const startupYear = parseInt(data.startup_date.split('-')[0])
  const currentYear = new Date().getFullYear()
  const yearsFromStartup = currentYear - startupYear
  
  if (yearsFromStartup > 5) {
    return { eligible: false, creditAmount: 0, reasons: '창업 후 5년이 경과했습니다', details: {} }
  }
  
  const tax = data.calculated_tax || 0
  const isYouthStartup = data.is_youth_startup || false
  const reductionRate = isYouthStartup ? 1.0 : 0.5
  const totalCredit = tax * reductionRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `${isYouthStartup ? '청년' : '일반'}창업 ${(reductionRate * 100).toFixed(0)}% 감면 (${yearsFromStartup + 1}년차)`,
    details: { startup_year: startupYear, years_from_startup: yearsFromStartup, reduction_rate: reductionRate, total_credit: totalCredit }
  }
}

function assessManufacturingRelocation(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.relocation_completed) {
    return { eligible: false, creditAmount: 0, reasons: '지방 이전 정보가 없습니다', details: {} }
  }
  
  if (company.industry !== '제조업') {
    return { eligible: false, creditAmount: 0, reasons: '제조업만 해당됩니다', details: {} }
  }
  
  if (company.is_capital_area === 1) {
    return { eligible: false, creditAmount: 0, reasons: '수도권에서 지방으로 이전한 경우만 해당됩니다', details: {} }
  }
  
  const tax = data.calculated_tax || 0
  const totalCredit = tax * 1.0  // 100% 감면
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: '제조업 지방 이전 100% 감면 (7년간)',
    details: { total_credit: totalCredit }
  }
}

function assessSocialEnterpriseReduction(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.certification) {
    return { eligible: false, creditAmount: 0, reasons: '사회적기업 또는 협동조합 인증 정보가 없습니다', details: {} }
  }
  
  const tax = data.calculated_tax || 0
  const certificationType = data.certification_type || '협동조합'
  const reductionRate = certificationType === '사회적기업' ? 1.0 : 0.5
  const totalCredit = tax * reductionRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `${certificationType} ${(reductionRate * 100).toFixed(0)}% 감면`,
    details: { certification_type: certificationType, reduction_rate: reductionRate, total_credit: totalCredit }
  }
}

function assessYouthStartupReduction(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.founder_age || data.founder_age > 34) {
    return { eligible: false, creditAmount: 0, reasons: '창업자가 34세 이하가 아닙니다', details: {} }
  }
  
  if (!data.startup_date) {
    return { eligible: false, creditAmount: 0, reasons: '창업 정보가 없습니다', details: {} }
  }
  
  const startupYear = parseInt(data.startup_date.split('-')[0])
  const currentYear = new Date().getFullYear()
  const yearsFromStartup = currentYear - startupYear
  
  if (yearsFromStartup > 5) {
    return { eligible: false, creditAmount: 0, reasons: '창업 후 5년이 경과했습니다', details: {} }
  }
  
  const tax = data.calculated_tax || 0
  const maxAmount = 200000000  // 연 2억원 한도
  let totalCredit = tax * 1.0
  
  if (totalCredit > maxAmount) {
    totalCredit = maxAmount
  }
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `청년창업 100% 감면 (연 2억원 한도, ${yearsFromStartup + 1}년차)`,
    details: { founder_age: data.founder_age, years_from_startup: yearsFromStartup, total_credit: totalCredit }
  }
}

function assessProductivityFacilities(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '생산성향상시설 투자 실적이 없습니다', details: {} }
  }
  
  const relevantInvestments = data.filter(inv => 
    inv.facility_type && ['자동화설비', '정보시스템', '계측장비'].includes(inv.facility_type)
  )
  
  if (relevantInvestments.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '해당 시설 투자가 없습니다', details: {} }
  }
  
  const totalInvestment = relevantInvestments.reduce((sum, inv) => sum + (inv.investment_amount || 0), 0)
  
  if (totalInvestment < 10000000) {
    return { eligible: false, creditAmount: 0, reasons: '투자금액이 1천만원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.03
  if (companyType === '중소기업') creditRate = 0.10
  else if (companyType === '중견기업') creditRate = 0.05
  
  const totalCredit = totalInvestment * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `생산성향상시설 투자 ${(totalInvestment / 100000000).toFixed(2)}억원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_investment: totalInvestment, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessEnergyEnvironmentFacilities(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '에너지절약·환경개선시설 투자 실적이 없습니다', details: {} }
  }
  
  const relevantInvestments = data.filter(inv => 
    inv.facility_type && ['에너지절약시설', '온실가스감축시설', '환경보전시설'].includes(inv.facility_type)
  )
  
  if (relevantInvestments.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '해당 시설 투자가 없습니다', details: {} }
  }
  
  const totalInvestment = relevantInvestments.reduce((sum, inv) => sum + (inv.investment_amount || 0), 0)
  
  if (totalInvestment < 10000000) {
    return { eligible: false, creditAmount: 0, reasons: '투자금액이 1천만원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.03
  if (companyType === '중소기업') creditRate = 0.10
  else if (companyType === '중견기업') creditRate = 0.05
  
  const totalCredit = totalInvestment * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `에너지·환경시설 투자 ${(totalInvestment / 100000000).toFixed(2)}억원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_investment: totalInvestment, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessSafetyFacilities(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '안전시설 투자 실적이 없습니다', details: {} }
  }
  
  const relevantInvestments = data.filter(inv => 
    inv.facility_type && ['화재예방설비', '안전보호장구', '작업환경개선설비'].includes(inv.facility_type)
  )
  
  if (relevantInvestments.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '해당 시설 투자가 없습니다', details: {} }
  }
  
  const totalInvestment = relevantInvestments.reduce((sum, inv) => sum + (inv.investment_amount || 0), 0)
  
  if (totalInvestment < 10000000) {
    return { eligible: false, creditAmount: 0, reasons: '투자금액이 1천만원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.03
  if (companyType === '중소기업') creditRate = 0.10
  else if (companyType === '중견기업') creditRate = 0.07
  
  const totalCredit = totalInvestment * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `안전시설 투자 ${(totalInvestment / 100000000).toFixed(2)}억원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_investment: totalInvestment, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessSmartFactory(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '스마트공장 설비 투자 실적이 없습니다', details: {} }
  }
  
  const relevantInvestments = data.filter(inv => 
    inv.facility_type && inv.facility_type.includes('스마트공장')
  )
  
  if (relevantInvestments.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '스마트공장 설비 투자가 없습니다', details: {} }
  }
  
  const totalInvestment = relevantInvestments.reduce((sum, inv) => sum + (inv.investment_amount || 0), 0)
  
  if (totalInvestment < 100000000) {
    return { eligible: false, creditAmount: 0, reasons: '투자금액이 1억원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.05
  if (companyType === '중소기업') creditRate = 0.15
  else if (companyType === '중견기업') creditRate = 0.10
  
  const totalCredit = totalInvestment * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `스마트공장 설비 투자 ${(totalInvestment / 100000000).toFixed(2)}억원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_investment: totalInvestment, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessRndExpense(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '연구개발비 지출 실적이 없습니다', details: {} }
  }
  
  const relevantRnd = data.filter(rnd => 
    rnd.rnd_type && ['일반연구개발비', '신성장동력연구개발비'].includes(rnd.rnd_type)
  )
  
  if (relevantRnd.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '해당 연구개발비가 없습니다', details: {} }
  }
  
  const companyType = company.company_type
  let totalCredit = 0
  
  for (const rnd of relevantRnd) {
    const expense = rnd.expense_amount || 0
    let creditRate = 0.05
    
    if (rnd.rnd_type === '일반연구개발비') {
      if (companyType === '중소기업') creditRate = 0.25
      else if (companyType === '중견기업') creditRate = 0.15
    } else if (rnd.rnd_type === '신성장동력연구개발비') {
      if (companyType === '중소기업') creditRate = 0.30
      else if (companyType === '중견기업') creditRate = 0.20
      else creditRate = 0.10
    }
    
    totalCredit += expense * creditRate
  }
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `연구개발비 세액공제 적용`,
    details: { total_credit: totalCredit }
  }
}

function assessDesignExpense(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '디자인 개발비 지출 실적이 없습니다', details: {} }
  }
  
  const relevantRnd = data.filter(rnd => rnd.rnd_type === '디자인개발비')
  
  if (relevantRnd.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '디자인 개발비가 없습니다', details: {} }
  }
  
  const totalExpense = relevantRnd.reduce((sum, rnd) => sum + (rnd.expense_amount || 0), 0)
  
  if (totalExpense < 1000000) {
    return { eligible: false, creditAmount: 0, reasons: '개발비가 100만원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.05
  if (companyType === '중소기업') creditRate = 0.25
  else if (companyType === '중견기업') creditRate = 0.15
  
  const totalCredit = totalExpense * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `디자인 개발비 ${(totalExpense / 10000).toFixed(0)}만원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_expense: totalExpense, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessNewTechnologyExpense(rule: any, company: any, data: any[]): AssessmentResult {
  if (!data || data.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '신기술 개발비 지출 실적이 없습니다', details: {} }
  }
  
  const relevantRnd = data.filter(rnd => rnd.rnd_type === '신기술개발비')
  
  if (relevantRnd.length === 0) {
    return { eligible: false, creditAmount: 0, reasons: '신기술 개발비가 없습니다', details: {} }
  }
  
  const totalExpense = relevantRnd.reduce((sum, rnd) => sum + (rnd.expense_amount || 0), 0)
  
  if (totalExpense < 1000000) {
    return { eligible: false, creditAmount: 0, reasons: '개발비가 100만원 미만입니다', details: {} }
  }
  
  const companyType = company.company_type
  let creditRate = 0.10
  if (companyType === '중소기업') creditRate = 0.30
  else if (companyType === '중견기업') creditRate = 0.20
  
  const totalCredit = totalExpense * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `데이터·AI·IoT 개발비 ${(totalExpense / 10000).toFixed(0)}만원, ${(creditRate * 100).toFixed(0)}% 공제`,
    details: { total_expense: totalExpense, credit_rate: creditRate, total_credit: totalCredit }
  }
}

function assessDonation(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.donation_amount) {
    return { eligible: false, creditAmount: 0, reasons: '기부금 지출 실적이 없습니다', details: {} }
  }
  
  const donationAmount = data.donation_amount
  const donationType = data.donation_type || '지정기부금'
  const income = data.business_income || 0
  
  let limitRate = 0.30
  let creditRate = 0.15
  
  if (donationType === '법정기부금') {
    limitRate = 1.0
  }
  
  const limit = income * limitRate
  const eligibleAmount = Math.min(donationAmount, limit)
  const totalCredit = eligibleAmount * creditRate
  
  return {
    eligible: true,
    creditAmount: totalCredit,
    reasons: `${donationType} ${(eligibleAmount / 10000).toFixed(0)}만원, 15% 공제`,
    details: { donation_type: donationType, donation_amount: donationAmount, eligible_amount: eligibleAmount, total_credit: totalCredit }
  }
}

function assessBusinessVehicle(rule: any, company: any, data: any): AssessmentResult {
  if (!data || !data.vehicle_count || data.vehicle_count < 1) {
    return { eligible: false, creditAmount: 0, reasons: '업무용 차량이 없습니다', details: {} }
  }
  
  const vehicleCount = data.vehicle_count
  const depreciation = data.depreciation_expense || 0
  const rental = data.rental_expense || 0
  const fuel = data.fuel_expense || 0
  
  const depreciationLimit = 8000000 * vehicleCount
  const rentalLimit = 12000000 * vehicleCount
  
  const eligibleDepreciation = Math.min(depreciation, depreciationLimit)
  const eligibleRental = Math.min(rental, rentalLimit)
  const eligibleFuel = fuel  // 한도 없음
  
  const totalEligible = eligibleDepreciation + eligibleRental + eligibleFuel
  const totalExpense = depreciation + rental + fuel
  const limitExceeded = totalExpense - totalEligible
  
  return {
    eligible: true,
    creditAmount: 0,  // 이건 공제가 아니라 한도 검증
    reasons: `업무용 차량 ${vehicleCount}대, 손금인정액 ${(totalEligible / 10000).toFixed(0)}만원`,
    details: {
      vehicle_count: vehicleCount,
      depreciation: { expense: depreciation, limit: depreciationLimit, eligible: eligibleDepreciation },
      rental: { expense: rental, limit: rentalLimit, eligible: eligibleRental },
      fuel: { expense: fuel, eligible: eligibleFuel },
      total_eligible: totalEligible,
      limit_exceeded: limitExceeded
    }
  }
}

// ==================== 메인 페이지 ====================

app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>조특법 세액공제 자동 판정 시스템</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-50">
        <div class="min-h-screen">
            <!-- 헤더 -->
            <header class="bg-indigo-600 text-white shadow-lg">
                <div class="container mx-auto px-4 py-6">
                    <h1 class="text-3xl font-bold">
                        <i class="fas fa-file-invoice-dollar mr-3"></i>
                        조특법 세액공제 자동 판정 시스템
                    </h1>
                    <p class="text-indigo-100 mt-2">조세특례제한법 기반 20개 세액공제 항목 자동 판정</p>
                </div>
            </header>

            <!-- 메인 컨텐츠 -->
            <main class="container mx-auto px-4 py-8">
                <!-- 안내 카드 -->
                <div class="bg-white rounded-lg shadow-md p-6 mb-8">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-info-circle text-indigo-600 mr-2"></i>
                        시스템 소개
                    </h2>
                    <p class="text-gray-600 mb-4">
                        본 시스템은 사업자의 재무·고용·투자·연구개발 데이터를 기반으로 
                        조세특례제한법상 적용 가능한 세액공제를 자동으로 판정합니다.
                    </p>
                    <div class="grid md:grid-cols-4 gap-4 mt-6">
                        <div class="text-center p-4 bg-indigo-50 rounded-lg">
                            <i class="fas fa-users text-3xl text-indigo-600 mb-2"></i>
                            <p class="font-semibold">고용 관련</p>
                            <p class="text-sm text-gray-600">5개 항목</p>
                        </div>
                        <div class="text-center p-4 bg-green-50 rounded-lg">
                            <i class="fas fa-building text-3xl text-green-600 mb-2"></i>
                            <p class="font-semibold">중소기업</p>
                            <p class="text-sm text-gray-600">5개 항목</p>
                        </div>
                        <div class="text-center p-4 bg-blue-50 rounded-lg">
                            <i class="fas fa-industry text-3xl text-blue-600 mb-2"></i>
                            <p class="font-semibold">투자·시설</p>
                            <p class="text-sm text-gray-600">4개 항목</p>
                        </div>
                        <div class="text-center p-4 bg-purple-50 rounded-lg">
                            <i class="fas fa-flask text-3xl text-purple-600 mb-2"></i>
                            <p class="font-semibold">연구개발</p>
                            <p class="text-sm text-gray-600">3개 항목</p>
                        </div>
                    </div>
                </div>

                <!-- 기능 버튼 -->
                <div class="grid md:grid-cols-2 gap-6">
                    <a href="/assessment" class="block">
                        <div class="bg-white rounded-lg shadow-md p-8 hover:shadow-xl transition-shadow cursor-pointer border-2 border-transparent hover:border-indigo-500">
                            <div class="flex items-center mb-4">
                                <div class="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mr-4">
                                    <i class="fas fa-calculator text-2xl text-indigo-600"></i>
                                </div>
                                <h3 class="text-xl font-bold text-gray-800">새로운 판정</h3>
                            </div>
                            <p class="text-gray-600">
                                사업자 정보를 입력하고 세액공제 항목을 자동으로 판정받으세요.
                            </p>
                        </div>
                    </a>

                    <a href="/rules" class="block">
                        <div class="bg-white rounded-lg shadow-md p-8 hover:shadow-xl transition-shadow cursor-pointer border-2 border-transparent hover:border-green-500">
                            <div class="flex items-center mb-4">
                                <div class="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mr-4">
                                    <i class="fas fa-book text-2xl text-green-600"></i>
                                </div>
                                <h3 class="text-xl font-bold text-gray-800">규칙 조회</h3>
                            </div>
                            <p class="text-gray-600">
                                20개 세액공제 규칙과 적용 요건을 상세하게 확인하세요.
                            </p>
                        </div>
                    </a>
                </div>

                <!-- 특징 안내 -->
                <div class="mt-8 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg shadow-lg p-8 text-white">
                    <h3 class="text-2xl font-bold mb-6">시스템 특징</h3>
                    <div class="grid md:grid-cols-3 gap-6">
                        <div>
                            <i class="fas fa-bolt text-3xl mb-3"></i>
                            <h4 class="font-semibold mb-2">실시간 판정</h4>
                            <p class="text-indigo-100 text-sm">
                                입력 즉시 20개 항목을 자동으로 판정하여 결과를 제공합니다.
                            </p>
                        </div>
                        <div>
                            <i class="fas fa-shield-alt text-3xl mb-3"></i>
                            <h4 class="font-semibold mb-2">정확한 계산</h4>
                            <p class="text-indigo-100 text-sm">
                                최신 조세특례제한법을 기반으로 정확한 공제액을 산출합니다.
                            </p>
                        </div>
                        <div>
                            <i class="fas fa-chart-line text-3xl mb-3"></i>
                            <h4 class="font-semibold mb-2">상세한 분석</h4>
                            <p class="text-indigo-100 text-sm">
                                판정 사유와 계산 근거를 상세하게 확인할 수 있습니다.
                            </p>
                        </div>
                    </div>
                </div>
            </main>

            <!-- 푸터 -->
            <footer class="bg-gray-800 text-gray-300 mt-12 py-6">
                <div class="container mx-auto px-4 text-center">
                    <p>&copy; 2025 조특법 세액공제 자동 판정 시스템. All rights reserved.</p>
                    <p class="text-sm mt-2 text-gray-400">
                        본 시스템은 참고용이며, 실제 세액 신고 시 전문가와 상담하시기 바랍니다.
                    </p>
                </div>
            </footer>
        </div>
    </body>
    </html>
  `)
})

export default app
