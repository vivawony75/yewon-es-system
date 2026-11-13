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
  
  // 기본 서명 대상자 예시 명단
  defaultSigners: [
    '홍길동',
    '김영희',
    '이철수',
    '박민수',
    '정수진'
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
