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

// ==================== 규칙 조회 페이지 ====================

app.get('/rules', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>세액공제 규칙 조회 | 조특법 판정 시스템</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-50">
        <!-- 헤더 -->
        <header class="bg-indigo-600 text-white shadow-lg">
            <div class="container mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <a href="/" class="flex items-center">
                        <i class="fas fa-arrow-left mr-3"></i>
                        <h1 class="text-2xl font-bold">세액공제 규칙 조회</h1>
                    </a>
                </div>
            </div>
        </header>

        <main class="container mx-auto px-4 py-8">
            <div class="bg-white rounded-lg shadow-md p-6 mb-8">
                <h2 class="text-xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-info-circle text-indigo-600 mr-2"></i>
                    조세특례제한법 기반 세액공제 규칙 (20개)
                </h2>
                <p class="text-gray-600">각 규칙을 클릭하면 상세 내용을 확인할 수 있습니다.</p>
            </div>

            <!-- 규칙 목록 로딩 -->
            <div id="rules-container" class="space-y-4">
                <div class="text-center py-12">
                    <i class="fas fa-spinner fa-spin text-4xl text-indigo-600 mb-4"></i>
                    <p class="text-gray-600">규칙을 불러오는 중...</p>
                </div>
            </div>
        </main>

        <script>
            // 규칙 데이터 로드
            async function loadRules() {
                try {
                    const response = await fetch('/api/rules');
                    const result = await response.json();
                    
                    if (result.success) {
                        displayRules(result.data);
                    } else {
                        showError('규칙을 불러올 수 없습니다.');
                    }
                } catch (error) {
                    console.error('API 호출 실패:', error);
                    showError('네트워크 오류가 발생했습니다.');
                }
            }

            // 규칙 표시
            function displayRules(rules) {
                const container = document.getElementById('rules-container');
                const categories = {
                    '고용': [],
                    '중소기업': [],
                    '투자': [],
                    '연구개발': [],
                    '기타': []
                };

                // 카테고리별 분류
                Object.entries(rules).forEach(([key, rule]) => {
                    if (categories[rule.category]) {
                        categories[rule.category].push({ key, ...rule });
                    }
                });

                // HTML 생성
                let html = '';
                const categoryIcons = {
                    '고용': 'fa-users',
                    '중소기업': 'fa-building',
                    '투자': 'fa-industry',
                    '연구개발': 'fa-flask',
                    '기타': 'fa-ellipsis-h'
                };
                const categoryColors = {
                    '고용': 'indigo',
                    '중소기업': 'green',
                    '투자': 'blue',
                    '연구개발': 'purple',
                    '기타': 'gray'
                };

                Object.entries(categories).forEach(([category, items]) => {
                    if (items.length === 0) return;
                    
                    const icon = categoryIcons[category];
                    const color = categoryColors[category];
                    
                    html += \`
                        <div class="mb-8">
                            <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center">
                                <i class="fas \${icon} text-\${color}-600 mr-2"></i>
                                \${category} 관련 (\${items.length}개)
                            </h3>
                            <div class="space-y-3">
                    \`;

                    items.forEach(rule => {
                        html += \`
                            <div class="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow border border-gray-200 overflow-hidden">
                                <button onclick="toggleRule('\${rule.key}')" class="w-full text-left p-4 focus:outline-none">
                                    <div class="flex items-center justify-between">
                                        <div class="flex-1">
                                            <div class="flex items-center">
                                                <span class="bg-\${color}-100 text-\${color}-800 text-xs font-medium px-2.5 py-0.5 rounded mr-2">
                                                    \${rule.article}
                                                </span>
                                                <h4 class="font-bold text-gray-800">\${rule.name}</h4>
                                            </div>
                                            <p class="text-sm text-gray-600 mt-2">\${rule.description}</p>
                                        </div>
                                        <i id="icon-\${rule.key}" class="fas fa-chevron-down text-gray-400 ml-4 transition-transform"></i>
                                    </div>
                                </button>
                                <div id="detail-\${rule.key}" class="hidden border-t border-gray-200 bg-gray-50 p-4">
                                    <div class="space-y-3">
                                        <!-- 적용 요건 -->
                                        <div>
                                            <h5 class="font-semibold text-gray-700 mb-2">
                                                <i class="fas fa-check-circle text-green-600 mr-1"></i>
                                                적용 요건
                                            </h5>
                                            <div class="bg-white rounded p-3 text-sm">
                                                \${formatRequirements(rule.requirements)}
                                            </div>
                                        </div>
                                        <!-- 공제액 -->
                                        <div>
                                            <h5 class="font-semibold text-gray-700 mb-2">
                                                <i class="fas fa-money-bill-wave text-indigo-600 mr-1"></i>
                                                공제 금액/율
                                            </h5>
                                            <div class="bg-white rounded p-3 text-sm">
                                                \${formatCreditAmount(rule.credit_amount)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        \`;
                    });

                    html += \`
                            </div>
                        </div>
                    \`;
                });

                container.innerHTML = html;
            }

            // 규칙 상세 토글
            function toggleRule(key) {
                const detail = document.getElementById(\`detail-\${key}\`);
                const icon = document.getElementById(\`icon-\${key}\`);
                
                detail.classList.toggle('hidden');
                icon.classList.toggle('rotate-180');
            }

            // 요건 포맷팅
            function formatRequirements(requirements) {
                if (!requirements) return '<p class="text-gray-500">요건 정보 없음</p>';
                
                let html = '<ul class="space-y-1">';
                Object.entries(requirements).forEach(([key, req]) => {
                    html += \`<li class="flex items-start">\`;
                    html += \`<i class="fas fa-dot-circle text-indigo-500 mr-2 mt-1 text-xs"></i>\`;
                    html += \`<span><strong>\${req.description || key}:</strong> \`;
                    
                    if (req.min !== undefined) html += \`최소 \${req.min.toLocaleString()}\`;
                    if (req.max !== undefined) html += \` ~ 최대 \${req.max.toLocaleString()}\`;
                    if (req.value !== undefined) html += \`\${req.value}\`;
                    if (req.values !== undefined) html += \`\${req.values.join(', ')}\`;
                    if (req.required !== undefined) html += req.required ? '필수' : '선택';
                    
                    html += \`</span></li>\`;
                });
                html += '</ul>';
                return html;
            }

            // 공제액 포맷팅
            function formatCreditAmount(creditAmount) {
                if (!creditAmount) return '<p class="text-gray-500">공제 정보 없음</p>';
                
                let html = '<div class="space-y-2">';
                
                if (typeof creditAmount === 'object') {
                    Object.entries(creditAmount).forEach(([key, value]) => {
                        if (typeof value === 'object' && value.description) {
                            html += \`
                                <div class="flex items-start">
                                    <i class="fas fa-check text-green-500 mr-2 mt-1"></i>
                                    <span><strong>\${key}:</strong> \${value.description}</span>
                                </div>
                            \`;
                        } else if (value.description) {
                            html += \`
                                <div class="flex items-start">
                                    <i class="fas fa-check text-green-500 mr-2 mt-1"></i>
                                    <span>\${value.description}</span>
                                </div>
                            \`;
                        }
                    });
                }
                
                html += '</div>';
                return html;
            }

            // 에러 표시
            function showError(message) {
                const container = document.getElementById('rules-container');
                container.innerHTML = \`
                    <div class="text-center py-12">
                        <i class="fas fa-exclamation-triangle text-4xl text-red-500 mb-4"></i>
                        <p class="text-gray-600">\${message}</p>
                        <button onclick="loadRules()" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">
                            다시 시도
                        </button>
                    </div>
                \`;
            }

            // 페이지 로드 시 실행
            loadRules();
        </script>
    </body>
    </html>
  `)
})

// ==================== 판정 입력 페이지 ====================

app.get('/assessment', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>새로운 판정 | 조특법 판정 시스템</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-50">
        <!-- 헤더 -->
        <header class="bg-indigo-600 text-white shadow-lg">
            <div class="container mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <a href="/" class="flex items-center">
                        <i class="fas fa-arrow-left mr-3"></i>
                        <h1 class="text-2xl font-bold">세액공제 판정</h1>
                    </a>
                    <div class="text-sm">
                        <span id="step-indicator">단계 1/5</span>
                    </div>
                </div>
            </div>
        </header>

        <main class="container mx-auto px-4 py-8 max-w-4xl">
            <!-- 진행 표시 -->
            <div class="mb-8">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-medium text-gray-700">진행률</span>
                    <span class="text-sm font-medium text-indigo-600" id="progress-percent">0%</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-2">
                    <div id="progress-bar" class="bg-indigo-600 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
                </div>
            </div>

            <!-- 단계별 폼 -->
            <div id="form-container" class="bg-white rounded-lg shadow-lg p-8">
                <!-- 단계 1: 사업자 정보 -->
                <div id="step-1" class="step-content">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6">
                        <i class="fas fa-building text-indigo-600 mr-2"></i>
                        1단계: 사업자 기본 정보
                    </h2>
                    
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                사업자등록번호 <span class="text-red-500">*</span>
                            </label>
                            <input type="text" id="business_number" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                   placeholder="123-45-67890" required>
                            <p class="text-xs text-gray-500 mt-1">숫자와 하이픈(-)으로 입력해주세요</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                회사명 <span class="text-red-500">*</span>
                            </label>
                            <input type="text" id="company_name" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                   placeholder="(주)테스트기업" required>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                대표자명 <span class="text-red-500">*</span>
                            </label>
                            <input type="text" id="ceo_name" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                   placeholder="홍길동" required>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                기업 규모 <span class="text-red-500">*</span>
                            </label>
                            <select id="company_type" 
                                    class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required>
                                <option value="">선택해주세요</option>
                                <option value="중소기업">중소기업</option>
                                <option value="중견기업">중견기업</option>
                                <option value="대기업">대기업</option>
                            </select>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                업종 <span class="text-red-500">*</span>
                            </label>
                            <select id="industry" 
                                    class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required>
                                <option value="">선택해주세요</option>
                                <option value="제조업">제조업</option>
                                <option value="건설업">건설업</option>
                                <option value="도매업">도매업</option>
                                <option value="소매업">소매업</option>
                                <option value="서비스업">서비스업</option>
                                <option value="IT업">IT업</option>
                                <option value="기타">기타</option>
                            </select>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                소재지 <span class="text-red-500">*</span>
                            </label>
                            <input type="text" id="location" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                   placeholder="서울특별시 강남구" required>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                수도권 여부 <span class="text-red-500">*</span>
                            </label>
                            <div class="flex gap-4">
                                <label class="flex items-center">
                                    <input type="radio" name="is_capital_area" value="1" class="mr-2" checked>
                                    <span>수도권 (서울/경기/인천)</span>
                                </label>
                                <label class="flex items-center">
                                    <input type="radio" name="is_capital_area" value="0" class="mr-2">
                                    <span>지방</span>
                                </label>
                            </div>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                과세연도 <span class="text-red-500">*</span>
                            </label>
                            <input type="number" id="year" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                   value="2024" min="2020" max="2030" required>
                        </div>
                    </div>

                    <div class="mt-8 flex justify-end">
                        <button onclick="nextStep()" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
                            다음 단계 <i class="fas fa-arrow-right ml-2"></i>
                        </button>
                    </div>
                </div>

                <!-- 단계 2: 고용 정보 -->
                <div id="step-2" class="step-content hidden">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6">
                        <i class="fas fa-users text-indigo-600 mr-2"></i>
                        2단계: 고용 관련 정보
                    </h2>
                    
                    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
                        <p class="text-sm text-blue-700">
                            <i class="fas fa-info-circle mr-1"></i>
                            고용 관련 세액공제를 받으실 경우에만 입력해주세요. 해당사항 없으면 0 또는 비워두셔도 됩니다.
                        </p>
                    </div>

                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                총 상시근로자 수 (명)
                            </label>
                            <input type="number" id="total_employees" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                전년 대비 증가 인원 (명)
                            </label>
                            <input type="number" id="employee_increase" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                            <p class="text-xs text-gray-500 mt-1">예: 작년 10명 → 올해 15명 = 5명 입력</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                청년(15-34세) 정규직 증가 인원 (명)
                            </label>
                            <input type="number" id="youth_employees" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                장애인 근로자 수 (명)
                            </label>
                            <input type="number" id="disabled_employees" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                경력단절여성 재고용 인원 (명)
                            </label>
                            <input type="number" id="career_break_women" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                연간 총 급여액 (원)
                            </label>
                            <input type="number" id="total_salary" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0" step="1000000">
                            <p class="text-xs text-gray-500 mt-1">예: 5억원 = 500000000</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                                사회보험료 사업주 납부액 (원)
                            </label>
                            <input type="number" id="insurance_paid" 
                                   class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                   placeholder="0" min="0">
                        </div>
                    </div>

                    <div class="mt-8 flex justify-between">
                        <button onclick="prevStep()" class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 font-medium">
                            <i class="fas fa-arrow-left mr-2"></i> 이전
                        </button>
                        <button onclick="nextStep()" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
                            다음 단계 <i class="fas fa-arrow-right ml-2"></i>
                        </button>
                    </div>
                </div>

                <!-- 단계 3: 투자 정보 -->
                <div id="step-3" class="step-content hidden">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6">
                        <i class="fas fa-industry text-indigo-600 mr-2"></i>
                        3단계: 투자 및 시설 정보
                    </h2>
                    
                    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
                        <p class="text-sm text-blue-700">
                            <i class="fas fa-info-circle mr-1"></i>
                            투자한 시설이 있는 경우에만 입력해주세요. 없으면 다음 단계로 넘어가셔도 됩니다.
                        </p>
                    </div>

                    <div id="investment-list" class="space-y-4 mb-4">
                        <!-- 투자 항목이 동적으로 추가됩니다 -->
                    </div>

                    <button onclick="addInvestment()" class="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-indigo-500 hover:text-indigo-600 transition-colors">
                        <i class="fas fa-plus mr-2"></i> 투자 항목 추가
                    </button>

                    <div class="mt-8 flex justify-between">
                        <button onclick="prevStep()" class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 font-medium">
                            <i class="fas fa-arrow-left mr-2"></i> 이전
                        </button>
                        <button onclick="nextStep()" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
                            다음 단계 <i class="fas fa-arrow-right ml-2"></i>
                        </button>
                    </div>
                </div>

                <!-- 단계 4: 연구개발 정보 -->
                <div id="step-4" class="step-content hidden">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6">
                        <i class="fas fa-flask text-indigo-600 mr-2"></i>
                        4단계: 연구개발 정보
                    </h2>
                    
                    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6">
                        <p class="text-sm text-blue-700">
                            <i class="fas fa-info-circle mr-1"></i>
                            연구개발비 지출이 있는 경우에만 입력해주세요.
                        </p>
                    </div>

                    <div id="rnd-list" class="space-y-4 mb-4">
                        <!-- 연구개발 항목이 동적으로 추가됩니다 -->
                    </div>

                    <button onclick="addRnd()" class="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-indigo-500 hover:text-indigo-600 transition-colors">
                        <i class="fas fa-plus mr-2"></i> 연구개발 항목 추가
                    </button>

                    <div class="mt-8 flex justify-between">
                        <button onclick="prevStep()" class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 font-medium">
                            <i class="fas fa-arrow-left mr-2"></i> 이전
                        </button>
                        <button onclick="nextStep()" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
                            다음 단계 <i class="fas fa-arrow-right ml-2"></i>
                        </button>
                    </div>
                </div>

                <!-- 단계 5: 기타 정보 및 확인 -->
                <div id="step-5" class="step-content hidden">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6">
                        <i class="fas fa-clipboard-check text-indigo-600 mr-2"></i>
                        5단계: 기타 정보 및 최종 확인
                    </h2>
                    
                    <div class="space-y-6">
                        <!-- 창업 정보 -->
                        <div class="border border-gray-200 rounded-lg p-4">
                            <h3 class="font-semibold text-gray-800 mb-4">창업 관련 정보 (선택)</h3>
                            <div class="space-y-3">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">창업일</label>
                                    <input type="date" id="startup_date" 
                                           class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                                </div>
                                <div>
                                    <label class="flex items-center">
                                        <input type="checkbox" id="is_youth_startup" class="mr-2">
                                        <span class="text-sm">청년창업 (대표자 34세 이하)</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <!-- 기부금 정보 -->
                        <div class="border border-gray-200 rounded-lg p-4">
                            <h3 class="font-semibold text-gray-800 mb-4">기부금 정보 (선택)</h3>
                            <div class="space-y-3">
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">기부금액 (원)</label>
                                    <input type="number" id="donation_amount" 
                                           class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                           placeholder="0" min="0">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">기부금 유형</label>
                                    <select id="donation_type" 
                                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                                        <option value="지정기부금">지정기부금</option>
                                        <option value="법정기부금">법정기부금</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <!-- 사업소득 정보 -->
                        <div class="border border-gray-200 rounded-lg p-4">
                            <h3 class="font-semibold text-gray-800 mb-4">사업소득 정보</h3>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-2">사업소득 (원)</label>
                                <input type="number" id="business_income" 
                                       class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                       placeholder="0" min="0" step="1000000">
                                <p class="text-xs text-gray-500 mt-1">예: 3억원 = 300000000</p>
                            </div>
                        </div>
                    </div>

                    <div class="mt-8 flex justify-between">
                        <button onclick="prevStep()" class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 font-medium">
                            <i class="fas fa-arrow-left mr-2"></i> 이전
                        </button>
                        <button onclick="submitAssessment()" class="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium">
                            <i class="fas fa-check mr-2"></i> 판정 실행
                        </button>
                    </div>
                </div>
            </div>
        </main>

        <script>
            let currentStep = 1;
            const totalSteps = 5;
            let companyId = null;

            // 단계 전환
            function showStep(step) {
                // 모든 단계 숨김
                for (let i = 1; i <= totalSteps; i++) {
                    document.getElementById(\`step-\${i}\`).classList.add('hidden');
                }
                
                // 현재 단계 표시
                document.getElementById(\`step-\${step}\`).classList.remove('hidden');
                
                // 진행 표시 업데이트
                const progress = (step / totalSteps) * 100;
                document.getElementById('progress-bar').style.width = progress + '%';
                document.getElementById('progress-percent').textContent = Math.round(progress) + '%';
                document.getElementById('step-indicator').textContent = \`단계 \${step}/\${totalSteps}\`;
                
                currentStep = step;
                window.scrollTo(0, 0);
            }

            async function nextStep() {
                if (currentStep === 1) {
                    // 1단계: 사업자 등록
                    if (!await registerCompany()) return;
                }
                
                if (currentStep < totalSteps) {
                    showStep(currentStep + 1);
                }
            }

            function prevStep() {
                if (currentStep > 1) {
                    showStep(currentStep - 1);
                }
            }

            // 사업자 등록
            async function registerCompany() {
                const businessNumber = document.getElementById('business_number').value;
                const companyName = document.getElementById('company_name').value;
                const ceoName = document.getElementById('ceo_name').value;
                const companyType = document.getElementById('company_type').value;
                const industry = document.getElementById('industry').value;
                const location = document.getElementById('location').value;
                const isCapitalArea = document.querySelector('input[name="is_capital_area"]:checked').value;

                if (!businessNumber || !companyName || !ceoName || !companyType || !industry || !location) {
                    alert('모든 필수 항목을 입력해주세요.');
                    return false;
                }

                try {
                    const response = await fetch('/api/companies', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            business_number: businessNumber,
                            company_name: companyName,
                            ceo_name: ceoName,
                            company_type: companyType,
                            industry: industry,
                            location: location,
                            is_capital_area: parseInt(isCapitalArea)
                        })
                    });

                    const result = await response.json();
                    
                    if (result.success) {
                        companyId = result.data.id;
                        return true;
                    } else {
                        alert('사업자 등록에 실패했습니다: ' + result.error);
                        return false;
                    }
                } catch (error) {
                    alert('네트워크 오류가 발생했습니다.');
                    return false;
                }
            }

            // 투자 항목 추가
            let investmentCount = 0;
            function addInvestment() {
                investmentCount++;
                const container = document.getElementById('investment-list');
                const div = document.createElement('div');
                div.className = 'border border-gray-200 rounded-lg p-4';
                div.innerHTML = \`
                    <div class="flex justify-between items-center mb-3">
                        <h4 class="font-medium text-gray-700">투자 항목 \${investmentCount}</h4>
                        <button onclick="this.parentElement.parentElement.remove()" class="text-red-500 hover:text-red-700">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="space-y-3">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">시설 종류</label>
                            <select class="investment-type w-full px-3 py-2 border border-gray-300 rounded">
                                <option value="자동화설비">자동화설비</option>
                                <option value="정보시스템">정보시스템</option>
                                <option value="에너지절약시설">에너지절약시설</option>
                                <option value="환경보전시설">환경보전시설</option>
                                <option value="화재예방설비">화재예방설비 (안전시설)</option>
                                <option value="스마트공장">스마트공장 설비</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">투자 금액 (원)</label>
                            <input type="number" class="investment-amount w-full px-3 py-2 border border-gray-300 rounded" 
                                   placeholder="10000000" min="0">
                        </div>
                    </div>
                \`;
                container.appendChild(div);
            }

            // 연구개발 항목 추가
            let rndCount = 0;
            function addRnd() {
                rndCount++;
                const container = document.getElementById('rnd-list');
                const div = document.createElement('div');
                div.className = 'border border-gray-200 rounded-lg p-4';
                div.innerHTML = \`
                    <div class="flex justify-between items-center mb-3">
                        <h4 class="font-medium text-gray-700">연구개발 항목 \${rndCount}</h4>
                        <button onclick="this.parentElement.parentElement.remove()" class="text-red-500 hover:text-red-700">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="space-y-3">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">연구개발 유형</label>
                            <select class="rnd-type w-full px-3 py-2 border border-gray-300 rounded">
                                <option value="일반연구개발비">일반 연구개발</option>
                                <option value="신성장동력연구개발비">신성장동력 연구개발</option>
                                <option value="디자인개발비">디자인 개발</option>
                                <option value="신기술개발비">데이터·AI·IoT 등 신기술</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">지출 금액 (원)</label>
                            <input type="number" class="rnd-amount w-full px-3 py-2 border border-gray-300 rounded" 
                                   placeholder="10000000" min="0">
                        </div>
                    </div>
                \`;
                container.appendChild(div);
            }

            // 최종 제출
            async function submitAssessment() {
                if (!companyId) {
                    alert('사업자 정보를 먼저 등록해주세요.');
                    return;
                }

                // 고용 데이터 수집
                const employmentData = {
                    total_employees: parseInt(document.getElementById('total_employees').value) || 0,
                    employee_increase: parseInt(document.getElementById('employee_increase').value) || 0,
                    youth_employees: parseInt(document.getElementById('youth_employees').value) || 0,
                    disabled_employees: parseInt(document.getElementById('disabled_employees').value) || 0,
                    career_break_women: parseInt(document.getElementById('career_break_women').value) || 0,
                    total_salary: parseInt(document.getElementById('total_salary').value) || 0,
                    insurance_paid: parseInt(document.getElementById('insurance_paid').value) || 0
                };

                // 투자 데이터 수집
                const investmentData = [];
                document.querySelectorAll('#investment-list > div').forEach(item => {
                    const type = item.querySelector('.investment-type').value;
                    const amount = parseInt(item.querySelector('.investment-amount').value) || 0;
                    if (amount > 0) {
                        investmentData.push({ facility_type: type, investment_amount: amount });
                    }
                });

                // 연구개발 데이터 수집
                const rndData = [];
                document.querySelectorAll('#rnd-list > div').forEach(item => {
                    const type = item.querySelector('.rnd-type').value;
                    const amount = parseInt(item.querySelector('.rnd-amount').value) || 0;
                    if (amount > 0) {
                        rndData.push({ rnd_type: type, expense_amount: amount });
                    }
                });

                // 기타 데이터 수집
                const otherData = {
                    startup_date: document.getElementById('startup_date').value || null,
                    is_youth_startup: document.getElementById('is_youth_startup').checked,
                    donation_amount: parseInt(document.getElementById('donation_amount').value) || 0,
                    donation_type: document.getElementById('donation_type').value,
                    business_income: parseInt(document.getElementById('business_income').value) || 0,
                    calculated_tax: (parseInt(document.getElementById('business_income').value) || 0) * 0.10
                };

                const year = parseInt(document.getElementById('year').value) || 2024;

                // 판정 API 호출
                try {
                    const response = await fetch('/api/assess', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            company_id: companyId,
                            year: year,
                            employmentData: employmentData,
                            investmentData: investmentData,
                            rndData: rndData,
                            otherData: otherData
                        })
                    });

                    const result = await response.json();
                    
                    if (result.success) {
                        alert('판정이 완료되었습니다!\\n\\n총 공제 가능액: ' + result.data.total_credit_amount.toLocaleString() + '원\\n적용 가능 항목: ' + result.data.eligible_count + '개');
                        window.location.href = \`/result?company_id=\${companyId}&year=\${year}\`;
                    } else {
                        alert('판정 실행에 실패했습니다: ' + result.error);
                    }
                } catch (error) {
                    alert('네트워크 오류가 발생했습니다.');
                    console.error(error);
                }
            }

            // 페이지 로드 시 1단계 표시
            showStep(1);
        </script>
    </body>
    </html>
  `)
})

export default app
