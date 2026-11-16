/**
 * [예원전자서명시스템] 기본 설정 파일 (config.js)
 */
window.APP_CONFIG = {
  // Firebase 클라우드 연동 설정
  firebaseConfig: {
    apiKey: "AIzaSyBMIJJv1LPvzZhOkGHqveaYeXKQ7myhNXE",
    authDomain: "yewon-es-system.firebaseapp.com",
    databaseURL: "https://yewon-es-system-default-rtdb.firebaseio.com",
    projectId: "yewon-es-system",
    storageBucket: "yewon-es-system.firebasestorage.app",
    messagingSenderId: "734443453114",
    appId: "1:734443453114:web:830b4a235983838dcd6083",
    measurementId: "G-DY4CTW2FWC"
  },

  // 관리자 아이디
  adminId: 'admin',
  
  // 관리자 비밀번호
  adminPassword: 'admin4441#',
  
  // 시스템 명칭
  systemTitle: '예원 전자서명 시스템',
  
  // 기본 서명 대상자 명단 (2026학년도 체험교실 출근부 1번~39번 정순서)
  defaultSigners: [
    '박은희', '예준호', '서민지', '양원자', '김미화',
    '김연옥', '서지언', '서호찬', '박진석', '김거울',
    '김형준', '이수연', '신유정', '유지혜', '박진우',
    '김동환', '박선옥', '정설희', '이선영', '정태욱',
    '김도형', '장재리', '임수정', '최준혁', '이경미',
    '김태현', '유경희', '탁은남', '예성원', '김경미',
    '박소영', '조유진', '김종찬', '하귀천', '장용수',
    '박상민', '김인진', '이장근', '이주성'
  ],
  
  // 기본 서명 위치 설정 (PDF 좌표: 포인트 단위 - 양식 칸 안에 쏙 들어가도록 기본값 설정)
  defaultSignaturePosition: {
    page: 1,      // 서명 들어갈 페이지 (1부터 시작)
    x: 390,       // X 좌표 (좌측 기준: 서명란 칸 내부)
    y: 125,       // Y 좌표 (하단 기준: 서명란 칸 내부)
    width: 135,   // 서명 이미지 너비 (양식 칸 안쪽에 안전 여백 확보)
    height: 52    // 서명 이미지 높이 (양식 칸 안쪽에 안전 여백 확보)
  }
};
