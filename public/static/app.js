// 전역 상태 관리
const state = {
  currentStep: 1,
  totalSteps: 5,
  companyId: null,
  companyData: {},
  employmentData: {},
  investmentData: [],
  rndData: [],
  otherData: {}
};

// 유틸리티 함수
function formatCurrency(amount) {
  return new Intl.NumberFormat('ko-KR').format(Math.round(amount)) + '원';
}

function formatNumber(num) {
  return new Intl.NumberFormat('ko-KR').format(num);
}

// API 호출 함수
async function apiCall(endpoint, method = 'GET', data = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  
  if (data) {
    options.body = JSON.stringify(data);
  }
  
  try {
    const response = await fetch(`/api${endpoint}`, options);
    return await response.json();
  } catch (error) {
    console.error('API 호출 실패:', error);
    return { success: false, error: error.message };
  }
}

// 페이지별 로직 로드
console.log('Tax Credit Assessment System Loaded');
