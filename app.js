/**
 * [예원전자서명시스템] 메인 애플리케이션 로직 (app.js)
 */

(function () {
  'use strict';
  try {

  // ==========================================================================
  // [1] 전역 상태 및 데이터베이스 관리 (IndexedDB)
  // ==========================================================================
  const DB_NAME = 'YewonESignDB';
  const DB_VERSION = 1;
  let db = null;

  // 인메모리 상태
  const state = {
    isAdminLoggedIn: false,
    currentSignerName: null,
    currentOutputMode: 'allInOne', // 'allInOne' (한 장에 모든 서명 기재) or 'individual' (개인별)
    cachedUnifiedPdfBytes: null,
    documents: [], // 다중 서류 관리 목록 [{ id, title, dept, createdAt, updatedAt, signers, signatures, ... }]
    currentDocId: null, // 현재 작업 중인 서류 ID
    signers: [...(window.APP_CONFIG?.defaultSigners || ['홍길동', '김영희', '이철수', '박민수', '정수진'])],
    signatures: {}, // name -> { name, signedAt, signatureImage, pdfBlob }
    isAutoFormMode: true,
    autoFormTitle: localStorage.getItem('yewon_auto_title') || '',
    autoFormDept: localStorage.getItem('yewon_auto_dept') || '',
    autoFormPositions: {}, // name -> { page, x, y, width, height }
    pdfTemplate: {
      name: '서명 양식.pdf',
      bytes: null
    },
    sigPosition: {
      page: window.APP_CONFIG?.defaultSignaturePosition?.page || 1,
      x: window.APP_CONFIG?.defaultSignaturePosition?.x || 390,
      y: window.APP_CONFIG?.defaultSignaturePosition?.y || 125,
      width: window.APP_CONFIG?.defaultSignaturePosition?.width || 135,
      height: window.APP_CONFIG?.defaultSignaturePosition?.height || 52
    }
  };

  // IndexedDB 초기화
  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains('files')) {
          database.createObjectStore('files', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('signatures')) {
          database.createObjectStore('signatures', { keyPath: 'name' });
        }
      };
      request.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      request.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        resolve(null); // 에러 발생 시 메모리/로컬스토리지 폴백
      };
    });
  }

  async function saveFileToDB(id, data, name) {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        store.put({ id, data, name, updatedAt: new Date().toISOString() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('saveFileToDB failed:', err);
        resolve(false);
      }
    });
  }

  async function getFileFromDB(id) {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  // ==========================================================================
  // [1-1] Firebase 클라우드 실시간 연동 (Realtime Database + Firestore 듀얼 지원)
  // ==========================================================================
  let firestore = null;
  let rtdb = null;
  let isCloudSynced = false;

  // Realtime Database 키 안전 변환 (특수문자 치환)
  function toSafeRtdbKey(str) {
    if (!str) return 'unknown';
    return encodeURIComponent(String(str).trim()).replace(/[\.\$#\[\]\/]/g, '_');
  }

  function initFirebase() {
    if (window.firebase && window.APP_CONFIG && window.APP_CONFIG.firebaseConfig) {
      try {
        if (!firebase.apps || !firebase.apps.length) {
          firebase.initializeApp(window.APP_CONFIG.firebaseConfig);
        }
        if (typeof firebase.database === 'function') {
          rtdb = firebase.database();
          console.log('[예원전자서명] Firebase Realtime Database 연결 성공');
        }
        if (typeof firebase.firestore === 'function') {
          try {
            firestore = firebase.firestore();
            console.log('[예원전자서명] Firebase Firestore 인스턴스 준비');
          } catch (fErr) {}
        }
        setupRealtimeCloudSync();
      } catch (err) {
        console.warn('[예원전자서명] Firebase 초기화 경고:', err);
      }
    }
  }

  function setupRealtimeCloudSync() {
    // 1. Realtime Database 실시간 구독 (모든 기기 실시간 100% 동기화)
    if (rtdb) {
      try {
        // (1) config/system 구독 (서명 대상자 명단, 양식 제목, 부서, 서명 위치)
        rtdb.ref('config/system').on('value', (snapshot) => {
          const cfg = snapshot.val();
          if (cfg) {
            let changed = false;
            if (Array.isArray(cfg.signers) && cfg.signers.length > 0) {
              state.signers = cfg.signers;
              localStorage.setItem('yewon_signers', JSON.stringify(state.signers));
              changed = true;
            }
            if (cfg.autoFormTitle !== undefined && cfg.autoFormTitle !== null) {
              state.autoFormTitle = cfg.autoFormTitle;
              localStorage.setItem('yewon_auto_title', state.autoFormTitle);
              if (el.autoFormTitle && document.activeElement !== el.autoFormTitle) {
                el.autoFormTitle.value = state.autoFormTitle;
              }
              changed = true;
            }
            if (cfg.autoFormDept !== undefined && cfg.autoFormDept !== null) {
              state.autoFormDept = cfg.autoFormDept;
              localStorage.setItem('yewon_auto_dept', state.autoFormDept);
              if (el.autoFormDept && document.activeElement !== el.autoFormDept) {
                el.autoFormDept.value = state.autoFormDept;
              }
              changed = true;
            }
            if (cfg.sigPosition) {
              state.sigPosition = { ...state.sigPosition, ...cfg.sigPosition };
              localStorage.setItem('yewon_sig_position', JSON.stringify(state.sigPosition));
              changed = true;
            }
            if (cfg.currentDocId && !state.currentDocId) {
              state.currentDocId = cfg.currentDocId;
            }

            isCloudSynced = true;

            // 대기 중인 성명 검증 콜백이 있으면 즉시 실행
            if (window._pendingNameCheck && typeof window._pendingNameCheck.check === 'function') {
              window._pendingNameCheck.check();
            }

            // 사용자 화면에서 성명 입력 단계에 머물러 있는 경우 자동 재검증
            if (el.userNameStep && el.userNameStep.style.display !== 'none') {
              const currentInput = el.signerNameInput ? el.signerNameInput.value.trim() : '';
              if (currentInput) {
                const norm = currentInput.replace(/\s+/g, '');
                if (state.signers.some(s => s.replace(/\s+/g, '') === norm)) {
                  console.log('[예원전자서명] 클라우드 명단 수신 완료 -> 자동 로그인 진행');
                  handleCheckSignerName();
                }
              }
            }

            if (changed) {
              if (typeof renderSignerTags === 'function') renderSignerTags();
              if (typeof renderProgressTable === 'function') renderProgressTable();
              if (typeof renderCompleteTable === 'function') renderCompleteTable();
              if (typeof updateDashboardStats === 'function') updateDashboardStats();
              if (state.isAutoFormMode && typeof generateAutoTablePdf === 'function') {
                generateAutoTablePdf(state.autoFormTitle, state.autoFormDept, state.signers)
                  .then(bytes => {
                    state.pdfTemplate.bytes = bytes;
                    state.pdfTemplate.name = `${state.autoFormTitle || '서명문서'}.pdf`;
                    refreshAdminAndUserPreview();
                  }).catch(() => {});
              }
            }
          }
        }, (err) => {
          console.warn('RTDB config 구독 오류:', err);
        });

        // (2) signatures 구독 (실시간 서명 현황 반영)
        rtdb.ref('signatures').on('value', (snapshot) => {
          const val = snapshot.val();
          if (val && typeof val === 'object') {
            let changed = false;
            Object.keys(val).forEach(key => {
              const rec = val[key];
              if (rec && rec.name) {
                const existing = state.signatures[rec.name];
                if (!existing || existing.signedAt !== rec.signedAt) {
                  state.signatures[rec.name] = {
                    name: rec.name,
                    signedAt: rec.signedAt || new Date().toISOString(),
                    signatureImage: rec.signatureImage || '',
                    pdfUrl: rec.pdfUrl || null,
                    pdfBlob: existing?.pdfBlob || null
                  };
                  changed = true;
                }
              }
            });
            if (changed) {
              if (typeof renderProgressTable === 'function') renderProgressTable();
              if (typeof renderCompleteTable === 'function') renderCompleteTable();
              if (typeof updateDashboardStats === 'function') updateDashboardStats();
            }
          }
        }, (err) => {
          console.warn('RTDB signatures 구독 오류:', err);
        });

        // (3) documents 구독 (다중 서류 목록 실시간 동기화)
        rtdb.ref('documents').on('value', (snapshot) => {
          const docsMap = snapshot.val();
          if (docsMap && typeof docsMap === 'object') {
            const docList = Array.isArray(docsMap) ? docsMap : Object.values(docsMap);
            if (docList.length > 0) {
              state.documents = docList;
              localStorage.setItem('yewon_docs_list', JSON.stringify(docList));
              if (typeof renderDocumentList === 'function') renderDocumentList();
            }
          }
        }, (err) => {
          console.warn('RTDB documents 구독 오류:', err);
        });

      } catch (rtdbErr) {
        console.warn('RTDB setup error:', rtdbErr);
      }
    }

    // 2. Firestore 구독 (백업)
    if (firestore) {
      try {
        firestore.collection('signatures').onSnapshot((snapshot) => {
          let changed = false;
          snapshot.forEach((doc) => {
            const data = doc.data();
            if (data && data.name) {
              let signedAtStr = data.signedAt;
              if (data.signedAt && typeof data.signedAt.toDate === 'function') {
                signedAtStr = data.signedAt.toDate().toISOString();
              } else if (!signedAtStr) {
                signedAtStr = new Date().toISOString();
              }
              if (!state.signatures[data.name] || state.signatures[data.name].signedAt !== signedAtStr) {
                state.signatures[data.name] = {
                  name: data.name,
                  signedAt: signedAtStr,
                  signatureImage: data.signatureImage || '',
                  pdfUrl: data.pdfUrl || null,
                  pdfBlob: state.signatures[data.name]?.pdfBlob || null
                };
                changed = true;
              }
            }
          });
          if (changed) {
            if (typeof renderProgressTable === 'function') renderProgressTable();
            if (typeof renderCompleteTable === 'function') renderCompleteTable();
            if (typeof updateDashboardStats === 'function') updateDashboardStats();
          }
        }, (err) => {});

        firestore.collection('config').doc('system').onSnapshot((doc) => {
          if (doc.exists) {
            const cfg = doc.data();
            if (cfg.signers && Array.isArray(cfg.signers) && cfg.signers.length > 0) {
              state.signers = cfg.signers;
              localStorage.setItem('yewon_signers', JSON.stringify(state.signers));
            }
            if (cfg.sigPosition) {
              state.sigPosition = { ...state.sigPosition, ...cfg.sigPosition };
              localStorage.setItem('yewon_sig_position', JSON.stringify(state.sigPosition));
            }
            if (typeof renderSignerTags === 'function') renderSignerTags();
            if (typeof renderProgressTable === 'function') renderProgressTable();
            if (typeof renderCompleteTable === 'function') renderCompleteTable();
            if (typeof updateDashboardStats === 'function') updateDashboardStats();
          }
        }, (err) => {});
      } catch (e) {}
    }
  }

  async function saveSignatureToDB(record) {
    // 1. Firebase Realtime Database 저장 (실시간 클라우드 전송)
    if (rtdb) {
      try {
        const safeKey = toSafeRtdbKey(record.name);
        await rtdb.ref(`signatures/${safeKey}`).set({
          name: record.name,
          docId: state.currentDocId || '',
          signedAt: record.signedAt || new Date().toISOString(),
          signatureImage: record.signatureImage || '',
          status: 'signed',
          updatedAt: new Date().toISOString()
        });
      } catch (rErr) {
        console.warn('RTDB 서명 저장 경고:', rErr);
      }
    }

    // 2. Firestore 저장 (백업)
    if (firestore) {
      try {
        let tsDate = new Date();
        if (record.signedAt) {
          const parsed = new Date(record.signedAt);
          if (!isNaN(parsed.getTime())) {
            tsDate = parsed;
          }
        }
        await firestore.collection('signatures').doc(record.name).set({
          name: record.name,
          signedAt: firebase.firestore.Timestamp.fromDate(tsDate),
          signatureImage: record.signatureImage || '',
          status: 'signed',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (fErr) {}
    }

    // 3. IndexedDB 로컬 저장
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('signatures', 'readwrite');
        const store = tx.objectStore('signatures');
        store.put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  }

  async function getAllSignaturesFromDB() {
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('signatures', 'readonly');
        const store = tx.objectStore('signatures');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (err) {
        resolve([]);
      }
    });
  }

  async function removeSignatureFromDB(name) {
    if (rtdb) {
      try {
        const safeKey = toSafeRtdbKey(name);
        await rtdb.ref(`signatures/${safeKey}`).remove();
      } catch (rErr) {}
    }
    if (firestore) {
      try {
        await firestore.collection('signatures').doc(name).delete();
      } catch (fErr) {}
    }
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('signatures', 'readwrite');
        const store = tx.objectStore('signatures');
        store.delete(name);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  }

  // 로컬스토리지 설정 로드 및 동기화
  function loadLocalSettings() {
    try {
      const savedSigners = localStorage.getItem('yewon_signers');
      if (savedSigners) {
        state.signers = JSON.parse(savedSigners);
      }
      const savedPos = localStorage.getItem('yewon_sig_position');
      if (savedPos) {
        state.sigPosition = { ...state.sigPosition, ...JSON.parse(savedPos) };
      }
    } catch (e) {
      console.warn('loadLocalSettings error:', e);
    }
  }

  function saveLocalSettings() {
    try {
      localStorage.setItem('yewon_signers', JSON.stringify(state.signers));
      localStorage.setItem('yewon_sig_position', JSON.stringify(state.sigPosition));
      localStorage.setItem('yewon_auto_title', state.autoFormTitle || '');
      localStorage.setItem('yewon_auto_dept', state.autoFormDept || '');

      // Realtime Database 실시간 클라우드 동기화 (모든 기기 실시간 전송)
      if (rtdb) {
        rtdb.ref('config/system').set({
          signers: state.signers,
          autoFormTitle: state.autoFormTitle || '',
          autoFormDept: state.autoFormDept || '',
          currentDocId: state.currentDocId || '',
          sigPosition: state.sigPosition,
          updatedAt: new Date().toISOString()
        }).catch(err => console.warn('RTDB config 동기화 오류:', err));
      }

      // Firestore 동기화 (백업)
      if (firestore) {
        firestore.collection('config').doc('system').set({
          signers: state.signers,
          sigPosition: state.sigPosition,
          title: state.autoFormTitle || '',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
      }
    } catch (e) {
      console.warn('saveLocalSettings error:', e);
    }
  }

  // ==========================================================================
  // [2] 2열 표준 표 양식 자동 생성 (제목, 부서/담당자명, 연번·성명·서명란 표)
  // ==========================================================================
  async function generateAutoTablePdf(title, dept, signers) {
    if (!window.PDFLib) {
      throw new Error('PDFLib 라이브러리를 사용할 수 없습니다.');
    }
    const { PDFDocument } = window.PDFLib;

    const docTitle = (title !== undefined ? title : (state.autoFormTitle || '')).trim();
    const docDept = (dept !== undefined ? dept : (state.autoFormDept || '')).trim();
    const signerList = Array.isArray(signers) && signers.length > 0 
      ? signers 
      : (state.signers && state.signers.length > 0 ? state.signers : ['홍길동', '김영희', '이철수', '박민수', '정수진']);

    // A4 규격: 595.28 pt x 841.89 pt (고화질 2배율 Canvas: 1191 x 1684 px)
    const scale = 2.0;
    const canvasW = Math.round(595.28 * scale);
    const canvasH = Math.round(841.89 * scale);

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    // 1. 전체 배경 (흰색)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 상단 테두리 포인트 장식선
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(36 * scale, 24 * scale, 523.28 * scale, 3 * scale);

    // 2. 문서 제목 (제목이 입력되어 있을 때만 작성되는 문서 상단 중앙에 크게 표기)
    if (docTitle) {
      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(18.5 * scale)}px "Malgun Gothic", "Pretendard", "Apple SD Gothic Neo", sans-serif`;
      const titleY = 52 * scale;
      ctx.fillText(docTitle, canvasW / 2, titleY);
    }

    // 3. 부서 또는 담당자명 (제목 우측 아래에 제목보다 작은 글씨로 표기)
    const deptY = 74 * scale;
    if (docDept) {
      ctx.fillStyle = '#475569';
      ctx.textAlign = 'right';
      ctx.font = `normal ${Math.round(10 * scale)}px "Malgun Gothic", "Pretendard", "Apple SD Gothic Neo", sans-serif`;
      ctx.fillText(docDept, (595.28 - 36) * scale, deptY);
    }

    // 상단 제목/부서 구분선 (균일한 선 두께 및 색상)
    const lineY = 85 * scale;
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(36 * scale, lineY);
    ctx.lineTo((595.28 - 36) * scale, lineY);
    ctx.stroke();

    // 4. 2열 분할 계산
    // "n명이면 왼쪽에 1번부터 세로로 n/2번까지, 오른쪽에 그 다음 번호부터 끝번호까지. 홀수면 왼쪽에 한 명 더 오게."
    const totalN = signerList.length;
    const leftCount = Math.ceil(totalN / 2); // 홀수면 왼쪽에 한 명 더 배치
    const rightCount = totalN - leftCount;
    const maxRows = Math.max(leftCount, 1);

    const leftSigners = signerList.slice(0, leftCount);
    const rightSigners = signerList.slice(leftCount);

    // 5. 표 규격 및 위치 계산 (좌우 각각 최대 30명씩 A4 한 장에 완벽 수용되는 행 높이 설정)
    const tableTop = 92 * scale;
    const headerH = 22.5 * scale; // 헤더 높이: 22.5pt
    const targetRowH = 22.8 * scale; // 각 행 높이: 22.8pt (좌우 각각 30행 수용 가능)

    const colGap = 11.28 * scale; // 좌우 열 사이 여백
    const totalContentW = 523.28 * scale;
    const singleColW = (totalContentW - colGap) / 2; // 한 열 너비: 256pt

    // 세부 열 너비: [연번 32pt], [성명 68pt], [서명란 156pt]
    const seqW = 32 * scale;
    const nameW = 68 * scale;
    const signW = singleColW - seqW - nameW;

    const positions = {};

    // 표 테두리 스타일 일원화: 동일한 두께(1px) 및 색상(#475569)으로 균일화
    const tableBorderColor = '#475569';
    const tableBorderWidth = 1 * scale;

    // 표 렌더링 헬퍼 함수
    function drawColumnTable(startX, signersSubset, startSeqIndex) {
      // 1) 헤더 행 그리기
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(startX, tableTop, singleColW, headerH);
      ctx.strokeStyle = tableBorderColor;
      ctx.lineWidth = tableBorderWidth;
      ctx.strokeRect(startX, tableTop, singleColW, headerH);

      // 헤더 구분 세로선
      ctx.beginPath();
      ctx.moveTo(startX + seqW, tableTop);
      ctx.lineTo(startX + seqW, tableTop + headerH);
      ctx.moveTo(startX + seqW + nameW, tableTop);
      ctx.lineTo(startX + seqW + nameW, tableTop + headerH);
      ctx.stroke();

      // 헤더 텍스트
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold ${Math.round(10 * scale)}px "Malgun Gothic", "Pretendard", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const headerTextY = tableTop + (headerH / 2);
      ctx.fillText('연번', startX + (seqW / 2), headerTextY);
      ctx.fillText('성명', startX + seqW + (nameW / 2), headerTextY);
      ctx.fillText('서명 (날인)', startX + seqW + nameW + (signW / 2), headerTextY);

      // 2) 데이터 행 그리기 (균일한 테두리 및 30명 수용 높이 적용)
      for (let r = 0; r < maxRows; r++) {
        const rowY = tableTop + headerH + (r * targetRowH);
        const name = signersSubset[r] || '';
        const seqNumber = startSeqIndex + r + 1;

        // 행 테두리 사각형 (단일 색상 및 동일 두께로 균일화)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(startX, rowY, singleColW, targetRowH);
        ctx.strokeStyle = tableBorderColor;
        ctx.lineWidth = tableBorderWidth;
        ctx.strokeRect(startX, rowY, singleColW, targetRowH);

        // 세로 구분선 (동일한 색상 및 두께)
        ctx.beginPath();
        ctx.moveTo(startX + seqW, rowY);
        ctx.lineTo(startX + seqW, rowY + targetRowH);
        ctx.moveTo(startX + seqW + nameW, rowY);
        ctx.lineTo(startX + seqW + nameW, rowY + targetRowH);
        ctx.stroke();

        const rowTextY = rowY + (targetRowH / 2);

        if (name) {
          // 연번
          ctx.fillStyle = '#475569';
          ctx.font = `normal ${Math.round(9.5 * scale)}px "Malgun Gothic", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(String(seqNumber), startX + (seqW / 2), rowTextY);

          // 성명
          ctx.fillStyle = '#0f172a';
          ctx.font = `bold ${Math.round(10.5 * scale)}px "Malgun Gothic", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(name, startX + seqW + (nameW / 2), rowTextY);

          // 서명란 워터마크 안내
          ctx.fillStyle = '#cbd5e1';
          ctx.font = `normal ${Math.round(8.5 * scale)}px "Malgun Gothic", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('(인)', startX + seqW + nameW + (signW / 2), rowTextY);

          // 서명 날인 좌표 계산 (PDF 포인트 좌표계: 좌하단 기준)
          const signCanvasX = startX + seqW + nameW;
          const signCanvasY = rowY;
          const signCanvasW = signW;
          const signCanvasH = targetRowH;

          const pdfX = Math.round(signCanvasX / scale);
          const pdfY = Math.round(841.89 - ((signCanvasY + signCanvasH) / scale));
          const pdfW = Math.round(signCanvasW / scale);
          const pdfH = Math.round(signCanvasH / scale);

          positions[name] = {
            page: 1,
            x: pdfX,
            y: pdfY,
            width: pdfW,
            height: pdfH
          };
        } else {
          // 우측 열 빈 칸 처리 (사선 표시)
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 1 * scale;
          ctx.beginPath();
          ctx.moveTo(startX, rowY);
          ctx.lineTo(startX + singleColW, rowY + targetRowH);
          ctx.stroke();
        }
      }
    }

    // 좌측 열 그리기 (1번 ~ leftCount)
    const leftStartX = 36 * scale;
    drawColumnTable(leftStartX, leftSigners, 0);

    // 우측 열 그리기 (leftCount + 1 ~ totalN)
    const rightStartX = leftStartX + singleColW + colGap;
    drawColumnTable(rightStartX, rightSigners, leftCount);

    // 6. PDFLib 문서로 변환 (표 아래 문구는 완전 삭제됨)
    state.autoFormPositions = positions;

    const pngDataUrl = canvas.toDataURL('image/png');
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const pngImage = await pdfDoc.embedPng(pngDataUrl);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: 595.28,
      height: 841.89
    });

    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
  }

  // ==========================================================================
  // [2-2] 기본 표준 서약서 PDF 자동 생성 (하위 호환 및 기본 템플릿 대체)
  // ==========================================================================
  async function generateDefaultPdfTemplate() {
    return await generateAutoTablePdf(
      state.autoFormTitle || '',
      state.autoFormDept || '',
      state.signers
    );
  }

  // ==========================================================================
  // [3] DOM 요소 참조
  // ==========================================================================
  const el = {
    // Header & Navigation
    brandLogo: document.getElementById('brandLogo'),
    currentRoleBadge: document.getElementById('currentRoleBadge'),
    btnSwitchToUser: document.getElementById('btnSwitchToUser'),
    btnSwitchToAdmin: document.getElementById('btnSwitchToAdmin'),
    btnAdminLogout: document.getElementById('btnAdminLogout'),
    
    // Header Inline Admin Login
    headerAdminLoginForm: document.getElementById('headerAdminLoginForm'),
    headerAdminId: document.getElementById('headerAdminId'),
    headerAdminPw: document.getElementById('headerAdminPw'),
    btnHeaderLogin: document.getElementById('btnHeaderLogin'),
    headerAdminLoggedInBar: document.getElementById('headerAdminLoggedInBar'),

    // User Screen
    userViewSection: document.getElementById('userViewSection'),
    userNameStep: document.getElementById('userNameStep'),
    signerNameInput: document.getElementById('signerNameInput'),
    btnCheckName: document.getElementById('btnCheckName'),
    nameErrorAlert: document.getElementById('nameErrorAlert'),

    // Signing Screen
    userSigningStep: document.getElementById('userSigningStep'),
    teacherGreetingTitle: document.getElementById('teacherGreetingTitle'),
    btnReenterName: document.getElementById('btnReenterName'),
    docFileNameBadge: document.getElementById('docFileNameBadge'),
    userDocViewerFrame: document.getElementById('userDocViewerFrame'),
    userDocPagesContainer: document.getElementById('userDocPagesContainer'),

    // Signature Canvas
    signatureCanvas: document.getElementById('signatureCanvas'),
    signatureCanvasContainer: document.getElementById('signatureCanvasContainer'),
    canvasWatermark: document.getElementById('canvasWatermark'),
    btnResetSign: document.getElementById('btnResetSign'),
    btnSubmitSign: document.getElementById('btnSubmitSign'),

    // Complete Screen
    userCompleteStep: document.getElementById('userCompleteStep'),
    completedTeacherName: document.getElementById('completedTeacherName'),
    btnDownloadMySignedPdf: document.getElementById('btnDownloadMySignedPdf'),
    btnRestartUserFlow: document.getElementById('btnRestartUserFlow'),

    // Admin Screen
    adminViewSection: document.getElementById('adminViewSection'),
    btnCreateNewDoc: document.getElementById('btnCreateNewDoc'),
    docListContainer: document.getElementById('docListContainer'),
    docCountBadge: document.getElementById('docCountBadge'),
    tabButtons: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),

    // Admin: [시작] Tab
    btnModeAutoForm: document.getElementById('btnModeAutoForm'),
    btnModeUploadPdf: document.getElementById('btnModeUploadPdf'),
    sectionAutoForm: document.getElementById('sectionAutoForm'),
    sectionUploadPdf: document.getElementById('sectionUploadPdf'),
    autoFormTitle: document.getElementById('autoFormTitle'),
    autoFormDept: document.getElementById('autoFormDept'),
    btnGenerateAutoForm: document.getElementById('btnGenerateAutoForm'),

    pdfDropzone: document.getElementById('pdfDropzone'),
    pdfFileInput: document.getElementById('pdfFileInput'),
    currentFormName: document.getElementById('currentFormName'),
    btnAutoExtractNames: document.getElementById('btnAutoExtractNames'),
    btnPreviewCurrentForm: document.getElementById('btnPreviewCurrentForm'),
    btnResetToDefaultForm: document.getElementById('btnResetToDefaultForm'),
    newSignerInput: document.getElementById('newSignerInput'),
    btnAddSigners: document.getElementById('btnAddSigners'),
    btnClearAllSigners: document.getElementById('btnClearAllSigners'),
    signerCountBadge: document.getElementById('signerCountBadge'),
    signerTagsList: document.getElementById('signerTagsList'),
    sigPageInput: document.getElementById('sigPageInput'),
    sigXInput: document.getElementById('sigXInput'),
    sigYInput: document.getElementById('sigYInput'),
    sigWidthInput: document.getElementById('sigWidthInput'),
    sigHeightInput: document.getElementById('sigHeightInput'),
    btnSaveStartConfig: document.getElementById('btnSaveStartConfig'),
    btnPresetDefault: document.getElementById('btnPresetDefault'),
    btnPresetTableSmall: document.getElementById('btnPresetTableSmall'),
    btnPresetTableMed: document.getElementById('btnPresetTableMed'),
    adminDocViewerFrame: document.getElementById('adminDocViewerFrame'),
    adminDocPagesContainer: document.getElementById('adminDocPagesContainer'),

    // Admin: [진행] Tab
    statTotalSigners: document.getElementById('statTotalSigners'),
    statCompletedSigners: document.getElementById('statCompletedSigners'),
    statPendingSigners: document.getElementById('statPendingSigners'),
    statProgressPercent: document.getElementById('statProgressPercent'),
    btnCopyUserSignLink: document.getElementById('btnCopyUserSignLink'),
    btnRefreshProgress: document.getElementById('btnRefreshProgress'),
    progressTableBody: document.getElementById('progressTableBody'),

    // Admin: [완료] Tab
    radioModeAllInOne: document.getElementById('radioModeAllInOne'),
    radioModeIndividual: document.getElementById('radioModeIndividual'),
    modeCardAllInOne: document.getElementById('modeCardAllInOne'),
    modeCardIndividual: document.getElementById('modeCardIndividual'),
    completeSectionAllInOne: document.getElementById('completeSectionAllInOne'),
    completeSectionIndividual: document.getElementById('completeSectionIndividual'),
    unifiedSignCountBadge: document.getElementById('unifiedSignCountBadge'),
    btnPrintUnifiedPdf: document.getElementById('btnPrintUnifiedPdf'),
    btnDownloadUnifiedPdf: document.getElementById('btnDownloadUnifiedPdf'),
    btnPreviewUnifiedPdf: document.getElementById('btnPreviewUnifiedPdf'),
    unifiedDocViewerFrame: document.getElementById('unifiedDocViewerFrame'),
    unifiedDocPagesContainer: document.getElementById('unifiedDocPagesContainer'),
    btnPrintAllIndividual: document.getElementById('btnPrintAllIndividual'),
    btnDownloadAllPdfZip: document.getElementById('btnDownloadAllPdfZip'),
    completeTableBody: document.getElementById('completeTableBody'),

    // Modals & Toast
    adminLoginModal: document.getElementById('adminLoginModal'),
    btnCloseLoginModal: document.getElementById('btnCloseLoginModal'),
    adminLoginForm: document.getElementById('adminLoginForm'),
    adminIdInput: document.getElementById('adminIdInput'),
    adminPwInput: document.getElementById('adminPwInput'),
    loginErrorAlert: document.getElementById('loginErrorAlert'),

    signatureViewModal: document.getElementById('signatureViewModal'),
    btnCloseSignatureModal: document.getElementById('btnCloseSignatureModal'),
    btnCloseSigModalBtn: document.getElementById('btnCloseSigModalBtn'),
    sigModalTitle: document.getElementById('sigModalTitle'),
    sigModalDate: document.getElementById('sigModalDate'),
    sigModalImage: document.getElementById('sigModalImage'),

    pdfPreviewModal: document.getElementById('pdfPreviewModal'),
    btnClosePdfPreviewModal: document.getElementById('btnClosePdfPreviewModal'),
    pdfPreviewModalTitle: document.getElementById('pdfPreviewModalTitle'),
    modalPdfPagesContainer: document.getElementById('modalPdfPagesContainer'),

    appToast: document.getElementById('appToast')
  };

  // ==========================================================================
  // [4] 토스트 알림 메시지 헬퍼
  // ==========================================================================
  let toastTimer = null;
  function showToast(message, duration = 2500) {
    if (!el.appToast) return;
    el.appToast.textContent = message;
    el.appToast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.appToast.style.display = 'none';
    }, duration);
  }

  // ==========================================================================
  // [5] 서명 캔버스 (HTML5 Canvas Signature Pad) 구현
  // ==========================================================================
  let canvasCtx = null;
  let isDrawing = false;
  let hasDrawn = false;
  let lastX = 0;
  let lastY = 0;

  function initSignatureCanvas() {
    const canvas = el.signatureCanvas;
    if (!canvas) return;
    const container = el.signatureCanvasContainer;

    // 고해상도(Retina) 캔버스 배율 처리
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    canvasCtx = canvas.getContext('2d');
    canvasCtx.scale(dpr, dpr);
    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';
    canvasCtx.lineWidth = 2.5;
    canvasCtx.strokeStyle = '#0f172a'; // 서명 잉크 색상

    clearSignatureCanvas();

    // 마우스 및 터치 포인터 이벤트 등록 (펜, 손가락, 마우스 통합)
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }

  function getCanvasPos(e) {
    const rect = el.signatureCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  function onPointerDown(e) {
    isDrawing = true;
    el.signatureCanvas.setPointerCapture(e.pointerId);
    const pos = getCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;

    if (!hasDrawn) {
      hasDrawn = true;
      if (el.canvasWatermark) el.canvasWatermark.style.opacity = '0';
    }

    // 단일 클릭 점 찍기
    canvasCtx.beginPath();
    canvasCtx.arc(lastX, lastY, canvasCtx.lineWidth / 2, 0, Math.PI * 2);
    canvasCtx.fillStyle = canvasCtx.strokeStyle;
    canvasCtx.fill();
  }

  function onPointerMove(e) {
    if (!isDrawing) return;
    const pos = getCanvasPos(e);

    canvasCtx.beginPath();
    canvasCtx.moveTo(lastX, lastY);
    canvasCtx.lineTo(pos.x, pos.y);
    canvasCtx.stroke();

    lastX = pos.x;
    lastY = pos.y;
  }

  function onPointerUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    try {
      el.signatureCanvas.releasePointerCapture(e.pointerId);
    } catch (err) {}
  }

  function clearSignatureCanvas() {
    if (!canvasCtx || !el.signatureCanvas) return;
    const rect = el.signatureCanvasContainer.getBoundingClientRect();
    canvasCtx.clearRect(0, 0, rect.width, rect.height);
    hasDrawn = false;
    if (el.canvasWatermark) el.canvasWatermark.style.opacity = '1';
  }

  // 캔버스 여백을 투명하게 잘라내어 순수 서명 획만 추출 (양식 칸 안쪽에 딱 맞추기 위함)
  function getTrimmedSignatureDataUrl(sourceCanvas) {
    if (!sourceCanvas) return null;
    const ctx = sourceCanvas.getContext('2d');
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    if (!w || !h) return sourceCanvas.toDataURL('image/png');

    try {
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      let minX = w, minY = h, maxX = 0, maxY = 0;
      let found = false;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const alpha = data[(y * w + x) * 4 + 3];
          if (alpha > 15) { // 획 픽셀 감지
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            found = true;
          }
        }
      }

      if (!found) return sourceCanvas.toDataURL('image/png');

      // 주변 안전 여백 (6px)
      const pad = 6;
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(w, maxX + pad);
      maxY = Math.min(h, maxY + pad);

      const cropW = Math.max(1, maxX - minX);
      const cropH = Math.max(1, maxY - minY);

      const trimmedCanvas = document.createElement('canvas');
      trimmedCanvas.width = cropW;
      trimmedCanvas.height = cropH;
      const tCtx = trimmedCanvas.getContext('2d');
      tCtx.drawImage(sourceCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

      return trimmedCanvas.toDataURL('image/png');
    } catch (e) {
      return sourceCanvas.toDataURL('image/png');
    }
  }

  // 캔버스 내용을 투명 배경 PNG 데이터 URL로 추출 (여백 자동 정리)
  function getSignatureDataUrl() {
    if (!hasDrawn) return null;
    return getTrimmedSignatureDataUrl(el.signatureCanvas);
  }

  // ==========================================================================
  // [6] PDF 표(스프레드시트 셀 그리드) 정밀 분석 & 성명 옆칸 자동 날인 좌표 계산
  // ==========================================================================

  // PDF 문서 내부의 표 선(스프레드시트 셀 테두리) 좌표를 분석하여 세로열(V) 및 가로행(H) 경계선 추출
  async function extractPdfTableGrid(pdfBytes) {
    if (!pdfBytes) return { vLines: [], hLines: [] };
    try {
      const vSet = new Set();
      const hSet = new Set();
      const bytes = (pdfBytes instanceof Uint8Array) ? pdfBytes : new Uint8Array(pdfBytes);
      const latinStr = new TextDecoder('latin1').decode(bytes);

      // stream ... endstream 블록 검색
      const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
      let match;

      while ((match = streamRegex.exec(latinStr)) !== null) {
        const streamStart = match.index + match[0].indexOf('\n') + 1;
        const streamEnd = match.index + match[0].lastIndexOf('endstream');
        if (streamEnd <= streamStart) continue;

        const streamBytes = bytes.subarray(streamStart, streamEnd);
        let decodedText = '';

        if (streamBytes.length > 2 && streamBytes[0] === 0x78 && window.DecompressionStream) {
          try {
            const rawBytes = streamBytes.subarray(2); // 2바이트 zlib 헤더 제외
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(rawBytes);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            let total = 0;
            for (const c of chunks) total += c.length;
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              merged.set(c, off);
              off += c.length;
            }
            decodedText = new TextDecoder('latin1').decode(merged);
          } catch (e) {
            decodedText = new TextDecoder('latin1').decode(streamBytes);
          }
        } else {
          decodedText = new TextDecoder('latin1').decode(streamBytes);
        }

        if (!decodedText) continue;

        // 1. 선 그리기 명령 파싱: x1 y1 m x2 y2 l
        const lineRegex = /([-\d.]+)\s+([-\d.]+)\s+m\s+([-\d.]+)\s+([-\d.]+)\s+l/g;
        let lm;
        while ((lm = lineRegex.exec(decodedText)) !== null) {
          const x1 = parseFloat(lm[1]);
          const y1 = parseFloat(lm[2]);
          const x2 = parseFloat(lm[3]);
          const y2 = parseFloat(lm[4]);

          // 수직선 (X 좌표 일치, 길이 8pt 이상) -> 열(Column) 셀 테두리 경계
          if (Math.abs(x1 - x2) < 0.8 && Math.abs(y1 - y2) > 8) {
            vSet.add(Math.round(x1 * 10) / 10);
          }
          // 수평선 (Y 좌표 일치, 길이 8pt 이상) -> 행(Row) 셀 테두리 경계
          if (Math.abs(y1 - y2) < 0.8 && Math.abs(x1 - x2) > 8) {
            hSet.add(Math.round(y1 * 10) / 10);
          }
        }

        // 2. 사각형 그리기 명령 파싱: x y w h re
        const reRegex = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re/g;
        let rm;
        while ((rm = reRegex.exec(decodedText)) !== null) {
          const rx = parseFloat(rm[1]);
          const ry = parseFloat(rm[2]);
          const rw = parseFloat(rm[3]);
          const rh = parseFloat(rm[4]);
          if (rw > 8 && rh > 8) {
            vSet.add(Math.round(rx * 10) / 10);
            vSet.add(Math.round((rx + rw) * 10) / 10);
            hSet.add(Math.round(ry * 10) / 10);
            hSet.add(Math.round((ry + rh) * 10) / 10);
          }
        }
      }

      const vLines = Array.from(vSet).sort((a, b) => a - b);
      const hLines = Array.from(hSet).sort((a, b) => a - b);
      return { vLines, hLines };
    } catch (err) {
      console.warn('extractPdfTableGrid error:', err);
      return { vLines: [], hLines: [] };
    }
  }

  // PDF 문서 내에서 로그인한 선생님 성명 위치 및 스프레드시트 셀 단위의 서명란 정밀 탐색 (한 셀 안 완벽 배치)
  async function findSignerNameCoordinates(pdfBytes, signerName) {
    if (!signerName) return null;
    const cleanTargetName = signerName.replace(/\s+/g, '');

    // [우선순위 1] 등록된 서명 대상자 명단 기반 2열 표 서명란 좌표 수학적 직접 계산 (각 선생님마다 고유 칸 배정, 절대 겹침 없음)
    if (state.signers && state.signers.length > 0) {
      const idx = state.signers.findIndex(s => s && s.replace(/\s+/g, '') === cleanTargetName);
      if (idx !== -1) {
        const totalN = state.signers.length;
        const leftCount = Math.ceil(totalN / 2); // 홀수면 왼쪽에 1명 더 배치
        const isLeft = idx < leftCount;
        const rowIndex = isLeft ? idx : (idx - leftCount);

        // A4 규격 (595.28 x 841.89 pt) 기반 2열 표 서명란 칸 위치
        // 좌측 서명란 시작 X: 136pt, 우측 서명란 시작 X: 403.28pt
        // 서명란 칸 너비: 156pt, 행 높이: 22.8pt
        // Y좌표 (PDF 좌하단 기준): 704.59 - (rowIndex * 22.8)pt
        const cellX = isLeft ? 136 : 403.28;
        const cellY = 704.59 - (rowIndex * 22.8);
        const cellW = 156;
        const cellH = 22.8;

        return {
          found: true,
          page: 1,
          x: cellX,
          y: cellY,
          width: cellW,
          height: cellH,
          isAutoCell: true,
          label: `${signerName} 선생님 서명란 (${idx + 1}번)`
        };
      }
    }

    // [우선순위 2] state.autoFormPositions 캐시에서 성명 매칭 (공백 정규화)
    if (state.autoFormPositions) {
      for (const [key, pos] of Object.entries(state.autoFormPositions)) {
        if (key && key.replace(/\s+/g, '') === cleanTargetName && pos) {
          return {
            found: true,
            page: pos.page || 1,
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
            isAutoCell: true
          };
        }
      }
    }

    if (!window.pdfjsLib || !pdfBytes) return null;
    try {
      // 1. PDF 표(스프레드시트 셀 테두리) 그리드 선 추출
      let grid = { vLines: [], hLines: [] };
      try {
        grid = await extractPdfTableGrid(pdfBytes);
      } catch (gridErr) {
        console.warn('Grid extraction error:', gridErr);
      }
      const hasGrid = (grid.vLines && grid.vLines.length >= 2);

      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      const pdf = await loadingTask.promise;
      const cleanTargetName = signerName.replace(/\s+/g, '');
      let bestMatch = null;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items || [];
        const viewport = page.getViewport({ scale: 1 });
        const pageWidth = viewport.width;
        const pageHeight = viewport.height;

        // 성명 매칭 및 옆 칸(서명 셀) 정중앙 좌표 계산
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cleanStr = (item.str || '').replace(/\s+/g, '');

          if (cleanStr.includes(cleanTargetName)) {
            const tx = item.transform[4];
            const ty = item.transform[5];
            const itemWidth = item.width || (cleanStr.length * 12);
            const itemHeight = item.height || 14;

            // [방식 1: 스프레드시트 셀 그리드 기반 정밀 정렬] - 사용자가 요청한 "한 칸을 스프레드시트 한 셀로 인식"
            if (hasGrid) {
              // 1-1. 해당 성명이 속한 행(Row) 셀의 상단/하단 경계 찾기
              const rowBottom = grid.hLines.filter(y => y <= (ty + 3)).pop();
              const rowTop = grid.hLines.find(y => y > (ty - 3));
              const rowH = (rowTop !== undefined && rowBottom !== undefined) ? (rowTop - rowBottom) : (itemHeight + 14);
              const rowCenterY = (rowTop !== undefined && rowBottom !== undefined) ? ((rowBottom + rowTop) / 2) : (ty + itemHeight * 0.35);

              // 1-2. 해당 성명이 속한 열(Name Column)의 좌/우 경계 찾기
              const colLeft = grid.vLines.filter(x => x <= (tx + 5)).pop();
              const colRight = grid.vLines.find(x => x > tx);

              if (colLeft !== undefined && colRight !== undefined) {
                // 1-3. 서명란 셀(Signature Cell) = 성명 열 바로 우측의 인접한 셀!
                const sigColLeft = colRight;
                const nextColRight = grid.vLines.find(x => x > (colRight + 5));
                const nameColWidth = colRight - colLeft;
                const sigColRight = (nextColRight !== undefined) ? nextColRight : (sigColLeft + nameColWidth);
                const sigColWidth = sigColRight - sigColLeft;

                // 1-4. 서명 셀의 가로/세로 정중앙 좌표 계산
                const cellCenterX = (sigColLeft + sigColRight) / 2;

                // 1-5. 서명이 셀 테두리(선)에 절대 닿거나 넘어가지 않도록 안전 여백(상하좌우)을 둔 규격 결정
                const targetWidth = Math.min(80, Math.max(50, sigColWidth - 14));
                const targetHeight = Math.min(24, Math.max(16, rowH - 6));

                const targetX = cellCenterX - (targetWidth / 2);
                const targetY = rowCenterY - (targetHeight / 2);

                console.log(`[스프레드시트 셀 인식] "${signerName}": 성명셀[${colLeft}~${colRight}] -> 서명셀[${sigColLeft}~${sigColRight}], 정중앙X=${cellCenterX}, 정중앙Y=${rowCenterY}`);

                return {
                  page: pageNum,
                  x: Math.round(targetX),
                  y: Math.round(targetY),
                  width: Math.round(targetWidth),
                  height: Math.round(targetHeight),
                  cellCenterX: Math.round(cellCenterX),
                  rowCenterY: Math.round(rowCenterY),
                  found: true,
                  isCellGrid: true
                };
              }
            }

            // [방식 2: 표 선이 없거나 텍스트 기반일 경우의 안전한 다음 셀 추정]
            let targetWidth = 75;
            let targetHeight = 22;
            const rowCenterY = ty + (itemHeight * 0.35);

            // 동일 행 우측 텍스트 탐색
            const sameRowRightItems = items.filter((it, idx) => {
              if (idx === i) return false;
              const yDiff = Math.abs(it.transform[5] - ty);
              return yDiff <= 10 && it.transform[4] > (tx + itemWidth - 2);
            }).sort((a, b) => a.transform[4] - b.transform[4]);

            let cellCenterX = null;

            // (인) 또는 (서명) 문구가 명시되어 있는 경우
            const signMarkerItem = sameRowRightItems.find(it => {
              const s = (it.str || '').replace(/\s+/g, '');
              return s.includes('(인)') || s.includes('(서명)') || s.includes('인') || s.includes('서명') || s.includes('도장');
            });

            if (signMarkerItem) {
              cellCenterX = signMarkerItem.transform[4] + ((signMarkerItem.width || 18) / 2);
              targetWidth = 65;
            } else if (cleanStr.endsWith('(인)') || cleanStr.endsWith('(서명)')) {
              cellCenterX = (tx + itemWidth) - 15;
              targetWidth = 65;
            } else {
              // 일반 표에서 다음 셀의 중심은 성명 글자 끝이 아니라, 충분한 열 너비(최소 85pt)를 확보한 다음 셀 중앙으로 배치!
              cellCenterX = tx + Math.max(85, itemWidth + 55);
            }

            let targetX = cellCenterX - (targetWidth / 2);
            let targetY = rowCenterY - (targetHeight / 2);

            if (targetX + targetWidth > pageWidth - 10) {
              targetX = Math.max(10, pageWidth - targetWidth - 10);
            }
            if (targetX < 10) targetX = 10;
            targetY = Math.max(10, Math.min(pageHeight - targetHeight - 10, targetY));

            bestMatch = {
              page: pageNum,
              x: Math.round(targetX),
              y: Math.round(targetY),
              width: targetWidth,
              height: targetHeight,
              cellCenterX: Math.round(cellCenterX),
              rowCenterY: Math.round(rowCenterY),
              found: true
            };

            return bestMatch;
          }
        }
      }

      return bestMatch;
    } catch (err) {
      console.warn('findSignerNameCoordinates error:', err);
      return null;
    }
  }

  async function renderPdfToContainer(pdfBytes, containerEl, customGuideCoord = null, isInteractive = false) {
    if (!window.pdfjsLib || !pdfBytes || !containerEl) return;

    // 객체나 버퍼 형태로 전달되었을 경우를 대비한 안전 변환
    const rawData = (pdfBytes && pdfBytes.bytes && pdfBytes.bytes instanceof Uint8Array) ? pdfBytes.bytes : pdfBytes;
    const dataArray = (rawData instanceof Uint8Array) ? rawData.slice() : new Uint8Array(rawData);

    containerEl.innerHTML = '<div style="padding: 1.5rem; color: #3b82f6; text-align: center;">문서를 불러오는 중입니다...</div>';

    try {
      const loadingTask = pdfjsLib.getDocument({ data: dataArray });
      const pdf = await loadingTask.promise;
      containerEl.innerHTML = '';

      // 서명 안내 가이드 박스 좌표 결정
      const activeCoord = customGuideCoord || {
        page: Number(state.sigPosition.page || 1),
        x: Number(state.sigPosition.x || 390),
        y: Number(state.sigPosition.y || 125),
        width: Number(state.sigPosition.width || 135),
        height: Number(state.sigPosition.height || 52),
        label: '✍️ 서명 날인 칸 (위치)'
      };

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.2 });
        const unscaledViewport = page.getViewport({ scale: 1.0 });

        const canvasWrapper = document.createElement('div');
        canvasWrapper.style.position = 'relative';
        canvasWrapper.style.display = 'inline-block';
        canvasWrapper.style.marginBottom = '1.25rem';

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
          canvasContext: context,
          viewport: viewport
        };

        canvasWrapper.appendChild(canvas);

        let createdGuideBox = null;

        // 서명 가이드 박스는 안내 좌표가 명시된 경우 또는 관리자 양식 위치 설정 화면에서만 표시 (통합본이나 단순 미리보기에서는 표시 안 함)
        const shouldShowGuide = (customGuideCoord && customGuideCoord.found && pageNum === Number(activeCoord.page)) ||
                                (containerEl === el.adminDocPagesContainer && pageNum === Number(activeCoord.page));

        if (shouldShowGuide) {
          const guideBox = document.createElement('div');
          guideBox.style.position = 'absolute';
          const scaleRatio = viewport.width / (unscaledViewport.width || 595.28);
          const boxX = activeCoord.x * scaleRatio;
          const boxY = viewport.height - (activeCoord.y + activeCoord.height) * scaleRatio;
          const boxW = activeCoord.width * scaleRatio;
          const boxH = activeCoord.height * scaleRatio;

          guideBox.style.left = `${boxX}px`;
          guideBox.style.top = `${boxY}px`;
          guideBox.style.width = `${boxW}px`;
          guideBox.style.height = `${boxH}px`;
          guideBox.style.border = '2px dashed #2563eb';
          guideBox.style.backgroundColor = 'rgba(37, 99, 235, 0.14)';
          guideBox.style.borderRadius = '4px';
          guideBox.style.pointerEvents = 'none';
          guideBox.style.display = 'flex';
          guideBox.style.alignItems = 'center';
          guideBox.style.justifyContent = 'center';
          guideBox.style.fontSize = '11px';
          guideBox.style.color = '#1d4ed8';
          guideBox.style.fontWeight = 'bold';
          guideBox.style.zIndex = '10';
          guideBox.textContent = activeCoord.label || '✍️ 서명 날인 위치 (칸 안)';
          canvasWrapper.appendChild(guideBox);
          createdGuideBox = guideBox;
        }

        // 관리자 모드 인터랙티브 클릭으로 칸 위치 즉시 지정
        if (isInteractive || containerEl === el.adminDocPagesContainer) {
          canvasWrapper.style.cursor = 'crosshair';
          canvasWrapper.title = '이 페이지의 원하는 칸을 클릭하시면 서명 위치가 해당 칸 안으로 이동합니다.';
          canvasWrapper.addEventListener('click', (e) => {
            const rect = canvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;

            const scaleRatio = viewport.width / (unscaledViewport.width || 595.28);
            const pdfX = clickX / scaleRatio;
            const pdfY = (viewport.height - clickY) / scaleRatio;

            const w = Number(state.sigPosition.width || 135);
            const h = Number(state.sigPosition.height || 52);

            state.sigPosition.page = pageNum;
            state.sigPosition.x = Math.max(10, Math.round(pdfX - (w / 2)));
            state.sigPosition.y = Math.max(10, Math.round(pdfY - (h / 2)));

            syncConfigInputs();
            saveLocalSettings();

            renderPdfToContainer(state.pdfTemplate.bytes, el.adminDocPagesContainer, {
              page: state.sigPosition.page,
              x: state.sigPosition.x,
              y: state.sigPosition.y,
              width: state.sigPosition.width,
              height: state.sigPosition.height,
              label: '✍️ 지정된 서명 칸 위치'
            }, true);

            showToast(`📍 클릭한 칸으로 서명 위치가 지정되었습니다 (P.${state.sigPosition.page}, X: ${state.sigPosition.x}, Y: ${state.sigPosition.y})`);
          });
        }

        containerEl.appendChild(canvasWrapper);
        await page.render(renderContext).promise;

        // 사용자 뷰일 경우 해당 서명 칸으로 부드럽게 스크롤
        if (containerEl === el.userDocPagesContainer && createdGuideBox) {
          setTimeout(() => {
            if (createdGuideBox && typeof createdGuideBox.scrollIntoView === 'function') {
              createdGuideBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 200);
        }
      }
    } catch (err) {
      console.error('PDF rendering failed:', err);
      containerEl.innerHTML = '<div style="padding: 2rem; color: #ef4444; text-align: center;">문서를 화면에 렌더링하지 못했습니다.</div>';
    }
  }

  // ==========================================================================
  // [7] 서명 날인 헬퍼 및 서명 합성 PDF 생성
  // ==========================================================================

  // 서명 이미지를 표 칸(Cell) 내부에 테두리 선을 절대 침범하지 않도록 안전 여백을 두고 정중앙에 날인
  function drawSignatureIntoCell(targetPage, signatureImage, cellCoord) {
    const posX = Number(cellCoord.x);
    const posY = Number(cellCoord.y);
    const posW = Number(cellCoord.width || 156);
    const posH = Number(cellCoord.height || 22.8);

    const imgWidth = signatureImage.width;
    const imgHeight = signatureImage.height;

    // 테두리 선 침범 방지 여백 설정:
    // 상하: 3.5pt 이상의 여백 (22.8pt 높이 칸에서 최대 높이를 15.5pt로 제한하여 상하 테두리선과 확실히 이격)
    // 좌우: 8pt 이상의 여백 (156pt 너비 칸에서 최대 너비를 138pt로 제한하여 좌우 테두리선과 확실히 이격)
    const padY = Math.max(3.5, posH * 0.16);
    const padX = Math.max(8, posW * 0.08);

    const maxW = Math.max(10, posW - (padX * 2));
    const maxH = Math.max(8, posH - (padY * 2));

    // 원본 종횡비 유지(fit: contain)하면서 칸 내부 최대 크기로 자동 스케일링
    const scale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
    const finalW = imgWidth * scale;
    const finalH = imgHeight * scale;

    // 칸 내부의 정중앙에 정확히 정렬 (상하좌우 테두리선과 완벽하게 분리되어 절대 선에 걸치지 않음)
    const finalX = posX + (posW - finalW) / 2;
    const finalY = posY + (posH - finalH) / 2;

    targetPage.drawImage(signatureImage, {
      x: finalX,
      y: finalY,
      width: finalW,
      height: finalH
    });

    return { finalX, finalY, finalW, finalH };
  }

  // 개인별 서명 합성 PDF 생성 (로그인한 이름 옆칸에 자동 날인)
  async function generateSignedPdf(signerName, signatureDataUrl) {
    if (!window.PDFLib) {
      throw new Error('PDFLib 라이브러리를 사용할 수 없습니다.');
    }
    const { PDFDocument } = window.PDFLib;

    // 자동 표 양식 모드인 경우 항상 깨끗한 최신 양식 원본 생성
    let templateBytes;
    if (state.isAutoFormMode) {
      templateBytes = await generateAutoTablePdf(state.autoFormTitle, state.autoFormDept, state.signers);
      state.pdfTemplate.bytes = templateBytes;
    } else {
      templateBytes = state.pdfTemplate.bytes;
      if (!templateBytes) {
        templateBytes = await generateDefaultPdfTemplate();
        state.pdfTemplate.bytes = templateBytes;
      }
    }

    const pdfDoc = await PDFDocument.load(templateBytes.slice());
    const signatureImage = await pdfDoc.embedPng(signatureDataUrl);

    // 로그인한 선생님 성명의 위치를 정밀 탐색 (성명 바로 옆칸)
    const nameCoord = await findSignerNameCoordinates(templateBytes, signerName);
    const pages = pdfDoc.getPages();

    if (nameCoord && nameCoord.found) {
      const targetPageNum = Math.min(Math.max(1, nameCoord.page), pages.length);
      const targetPage = pages[targetPageNum - 1];
      drawSignatureIntoCell(targetPage, signatureImage, nameCoord);
      console.log(`[예원전자서명] "${signerName}" 선생님 이름 옆칸 위치에 정밀 날인: ${targetPageNum}페이지 (X: ${nameCoord.x}, Y: ${nameCoord.y}, W: ${nameCoord.width}, H: ${nameCoord.height})`);
    } else {
      // 텍스트 미발견 시: 관리자 기본 설정 좌표 사용
      const targetPageNum = Math.min(Math.max(1, Number(state.sigPosition.page || 1)), pages.length);
      const targetPage = pages[targetPageNum - 1];
      drawSignatureIntoCell(targetPage, signatureImage, state.sigPosition);
    }

    const signedBytes = await pdfDoc.save();
    return signedBytes;
  }

  // ==========================================================================
  // [7-1] 모든 사용자 서명을 한 장(통합 문서)에 기재하여 생성 (통합 서명본)
  // ==========================================================================
  async function generateUnifiedPdf() {
    if (!window.PDFLib) {
      throw new Error('PDFLib 라이브러리를 사용할 수 없습니다.');
    }
    const { PDFDocument } = window.PDFLib;

    // 항상 최신 명단과 서식으로 깨끗한 원본 양식을 준비
    let templateBytes;
    if (state.isAutoFormMode) {
      templateBytes = await generateAutoTablePdf(state.autoFormTitle, state.autoFormDept, state.signers);
      state.pdfTemplate.bytes = templateBytes;
    } else {
      templateBytes = state.pdfTemplate.bytes;
      if (!templateBytes) {
        templateBytes = await generateDefaultPdfTemplate();
        state.pdfTemplate.bytes = templateBytes;
      }
    }

    const pdfDoc = await PDFDocument.load(templateBytes.slice());
    const pages = pdfDoc.getPages();

    let signedCount = 0;

    // 등록된 모든 대상자 중 서명이 제출된 사용자의 서명을 순회하여 각자의 고유 서명란에 날인
    for (const signerName of state.signers) {
      const record = state.signatures[signerName];
      if (record && record.signatureImage) {
        try {
          const signatureImage = await pdfDoc.embedPng(record.signatureImage);
          const cellCoord = await findSignerNameCoordinates(templateBytes, signerName);

          if (cellCoord && cellCoord.found) {
            const targetPageNum = Math.min(Math.max(1, cellCoord.page), pages.length);
            const targetPage = pages[targetPageNum - 1];

            // 테두리 선을 절대 침범하지 않도록 칸 내부 여백 유지하며 정중앙 날인
            drawSignatureIntoCell(targetPage, signatureImage, cellCoord);
            signedCount++;
          }
        } catch (err) {
          console.warn(`[예원전자서명] "${signerName}" 통합 서명 날인 실패:`, err);
        }
      }
    }

    const unifiedPdfBytes = await pdfDoc.save();
    return unifiedPdfBytes;
  }

  // PDF 즉시 인쇄(출력) 헬퍼
  function printPdfBytes(pdfBytes, title = '예원전자서명문서') {
    if (!pdfBytes) {
      showToast('⚠️ 출력할 문서 데이터가 없습니다.');
      return;
    }
    try {
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);

      let printIframe = document.getElementById('appPrintIframe');
      if (!printIframe) {
        printIframe = document.createElement('iframe');
        printIframe.id = 'appPrintIframe';
        printIframe.style.position = 'fixed';
        printIframe.style.right = '0';
        printIframe.style.bottom = '0';
        printIframe.style.width = '0';
        printIframe.style.height = '0';
        printIframe.style.border = '0';
        document.body.appendChild(printIframe);
      }

      printIframe.src = blobUrl;
      printIframe.onload = function() {
        setTimeout(() => {
          try {
            printIframe.contentWindow.focus();
            printIframe.contentWindow.print();
          } catch (e) {
            window.open(blobUrl, '_blank');
          }
        }, 300);
      };
    } catch (err) {
      console.error('Print error:', err);
      showToast('❌ 인쇄 창을 여는 중 오류가 발생했습니다.');
    }
  }

  // ==========================================================================
  // [8] 사용자 화면 로직 (User View Controller)
  // ==========================================================================
  
  // 1단계: 성명 확인 처리
  function handleCheckSignerName() {
    const rawInput = el.signerNameInput ? el.signerNameInput.value.trim() : '';
    if (!rawInput) {
      showNameError('성명을 입력해 주세요.');
      return;
    }

    const normalizedInput = rawInput.replace(/\s+/g, '');
    const lowerInput = normalizedInput.toLowerCase();

    // 사용자가 가운데 성명 입력창에 'admin' 또는 '관리자'를 적은 경우 자동 안내
    if (lowerInput === 'admin' || lowerInput === '관리자') {
      if (el.headerAdminPw) {
        el.headerAdminPw.focus();
      }
      openAdminLoginModal();
      showToast('⚙️ 관리자 로그인 창입니다. 비밀번호(admin4441#)를 입력해 주세요.');
      return;
    }

    // 이름 일치 검사 함수
    const findSigner = () => state.signers.find(
      s => s.replace(/\s+/g, '') === normalizedInput
    );

    const matchedSigner = findSigner();

    if (matchedSigner) {
      // 일치하는 경우: 요구사항 문구 “000 선생님 반갑습니다” 표기하고 서명란 제시
      el.nameErrorAlert.style.display = 'none';
      state.currentSignerName = matchedSigner;
      proceedToSigningStep(matchedSigner);
      return;
    }

    // 다른 기기 접속 직후 클라우드 명단이 아직 수신되지 않은 경우
    if (!isCloudSynced && rtdb) {
      showNameError('⏳ 클라우드에서 최신 명단을 확인 중입니다. 잠시만 기다려 주세요...');

      // 클라우드 데이터 수신 시 즉시 호출될 대기 핸들러 등록
      window._pendingNameCheck = {
        name: normalizedInput,
        check: () => {
          const cloudMatched = findSigner();
          if (cloudMatched) {
            el.nameErrorAlert.style.display = 'none';
            state.currentSignerName = cloudMatched;
            proceedToSigningStep(cloudMatched);
            window._pendingNameCheck = null;
          }
        }
      };

      // 1.5초 후에도 없으면 최종 '다시 입력해 주세요' 표시
      setTimeout(() => {
        const finalMatched = findSigner();
        if (finalMatched) {
          el.nameErrorAlert.style.display = 'none';
          state.currentSignerName = finalMatched;
          proceedToSigningStep(finalMatched);
        } else {
          showNameError('다시 입력해 주세요');
        }
        window._pendingNameCheck = null;
      }, 1500);
      return;
    }

    // 일치하는 성명이 없으면: 요구사항 문구 “다시 입력해 주세요” 표기
    showNameError('다시 입력해 주세요');
  }

  function showNameError(msg) {
    el.nameErrorAlert.textContent = msg;
    el.nameErrorAlert.style.display = 'block';
    el.signerNameInput.focus();
  }

  // 2단계: 서명 화면으로 전환 (요구사항: “000 선생님 반갑습니다” 표기하고 서명란 제시)
  async function proceedToSigningStep(teacherName) {
    el.userNameStep.style.display = 'none';
    el.userSigningStep.style.display = 'block';
    el.userCompleteStep.style.display = 'none';

    // 요구사항: “000 선생님 반갑습니다” 표기
    if (el.teacherGreetingTitle) {
      el.teacherGreetingTitle.textContent = `${teacherName} 선생님 반갑습니다`;
    }

    // 캔버스 초기화
    setTimeout(() => {
      initSignatureCanvas();
    }, 50);
  }

  // 성명 다시 입력하기 버튼
  function handleReenterName() {
    el.userSigningStep.style.display = 'none';
    el.userNameStep.style.display = 'block';
    el.signerNameInput.value = '';
    el.signerNameInput.focus();
    el.nameErrorAlert.style.display = 'none';
    state.currentSignerName = null;
  }

  // 서명 제출 처리
  async function handleSubmitSignature() {
    if (!hasDrawn) {
      showToast('⚠️ 서명란에 서명을 먼저 작성해 주세요.');
      return;
    }

    if (!state.currentSignerName) {
      showToast('⚠️ 서명자 정보가 확인되지 않았습니다.');
      return;
    }

    const teacherName = state.currentSignerName;
    const signatureDataUrl = getSignatureDataUrl();

    if (!signatureDataUrl) {
      showToast('⚠️ 유효한 서명 이미지를 가져오지 못했습니다. 다시 서명해 주세요.');
      return;
    }

    el.btnSubmitSign.disabled = true;
    el.btnSubmitSign.textContent = '⏳ 서명 처리 중...';

    try {
      // PDF에 서명 합성 날인
      const signedPdfBytes = await generateSignedPdf(teacherName, signatureDataUrl);
      const signedAt = new Date().toLocaleString('ko-KR');

      // 저장 레코드 구성
      const record = {
        name: teacherName,
        signedAt: signedAt,
        signatureImage: signatureDataUrl,
        pdfBytes: signedPdfBytes
      };

      state.signatures[teacherName] = record;
      state.cachedUnifiedPdfBytes = null; // 통합 문서 캐시 무효화
      await saveSignatureToDB(record);

      // 사용자 완료 화면 전환 및 성공 알림
      el.userSigningStep.style.display = 'none';
      el.userCompleteStep.style.display = 'block';
      el.completedTeacherName.textContent = teacherName;
      showToast(`🎉 ${teacherName} 선생님의 서명이 성공적으로 제출되었습니다!`);

      // 관리자 실시간 테이블 및 서류 목록 자동 갱신
      try {
        saveDocumentsList();
        renderDocumentList();
        renderProgressTable();
        renderCompleteTable();
        updateCompleteTabUI();
        updateDashboardStats();
        refreshAdminAndUserPreview();
      } catch (uiErr) {
        console.warn('관리자 화면 갱신 알림 (서명은 정상 제출 완료됨):', uiErr);
      }
    } catch (err) {
      console.error('Signature submission error:', err);
      showToast('❌ 서명 제출 중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      el.btnSubmitSign.disabled = false;
      el.btnSubmitSign.textContent = '✅ 제출';
    }
  }

  // 본인 서명된 PDF 다운로드
  function handleDownloadMySignedPdf() {
    const teacherName = state.currentSignerName;
    const record = state.signatures[teacherName];
    if (!record || !record.pdfBytes) {
      showToast('서명된 문서 데이터를 찾을 수 없습니다.');
      return;
    }
    const filename = `[서명완료]_${teacherName}_${state.pdfTemplate.name || '서약서'}`;
    downloadPdfBytes(record.pdfBytes, filename);
  }

  // 첫 화면으로 돌아가기
  function handleRestartUserFlow() {
    el.userCompleteStep.style.display = 'none';
    el.userNameStep.style.display = 'block';
    el.signerNameInput.value = '';
    el.signerNameInput.focus();
    clearSignatureCanvas();
    state.currentSignerName = null;
  }

  // ==========================================================================
  // [9] 관리자 로그인 및 화면 제어 (Admin Controller)
  // ==========================================================================
  
  // 상단 우측 인라인 관리자 로그인 처리
  function handleHeaderLogin(e) {
    if (e && e.preventDefault) e.preventDefault();
    const inputId = el.headerAdminId ? el.headerAdminId.value.trim() : '';
    const inputPw = el.headerAdminPw ? el.headerAdminPw.value : '';

    if (!inputId) {
      showToast('⚠️ 관리자 아이디를 입력해 주세요.');
      if (el.headerAdminId) el.headerAdminId.focus();
      return;
    }
    if (!inputPw) {
      showToast('⚠️ 관리자 비밀번호를 입력해 주세요.');
      if (el.headerAdminPw) el.headerAdminPw.focus();
      return;
    }

    const targetId = window.APP_CONFIG?.adminId || 'admin';
    const targetPw = window.APP_CONFIG?.adminPassword || 'admin4441#';

    if (inputId === targetId && inputPw === targetPw) {
      state.isAdminLoggedIn = true;
      try { sessionStorage.setItem('yewon_admin_logged_in', 'true'); } catch (err) {}
      updateLoginHeaderUI(true);
      switchToAdminView();
      showToast('🔓 관리자로 로그인되었습니다.');
    } else {
      showToast('⚠️ 관리자 아이디 또는 비밀번호가 올바르지 않습니다.');
      if (el.headerAdminPw) {
        el.headerAdminPw.style.borderColor = '#ef4444';
        el.headerAdminPw.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.2)';
        setTimeout(() => {
          if (el.headerAdminPw) {
            el.headerAdminPw.style.borderColor = '';
            el.headerAdminPw.style.boxShadow = '';
          }
        }, 1800);
        el.headerAdminPw.value = '';
        el.headerAdminPw.focus();
      }
    }
  }

  // 관리자 로그아웃
  function handleAdminLogout() {
    state.isAdminLoggedIn = false;
    try { sessionStorage.removeItem('yewon_admin_logged_in'); } catch (err) {}
    updateLoginHeaderUI(false);
    switchToUserView();
    showToast('🔒 관리자 로그아웃되었습니다.');
  }

  // 상단 우측 UI 상태 갱신 (로그인 전/후 전환)
  function updateLoginHeaderUI(isLoggedIn) {
    if (isLoggedIn) {
      if (el.headerAdminLoginForm) el.headerAdminLoginForm.style.display = 'none';
      if (el.headerAdminLoggedInBar) el.headerAdminLoggedInBar.style.display = 'inline-flex';
      if (el.currentRoleBadge) {
        el.currentRoleBadge.textContent = '관리자 모드';
        el.currentRoleBadge.style.background = '#fef3c7';
        el.currentRoleBadge.style.color = '#b45309';
      }
    } else {
      if (el.headerAdminLoginForm) el.headerAdminLoginForm.style.display = 'flex';
      if (el.headerAdminLoggedInBar) el.headerAdminLoggedInBar.style.display = 'none';
      if (el.headerAdminPw) el.headerAdminPw.value = '';
      if (el.currentRoleBadge) {
        el.currentRoleBadge.textContent = '사용자 모드';
        el.currentRoleBadge.style.background = 'var(--primary-light)';
        el.currentRoleBadge.style.color = 'var(--primary)';
      }
    }
  }

  function switchToAdminView() {
    el.userViewSection.style.display = 'none';
    el.adminViewSection.style.display = 'block';
    if (el.btnSwitchToAdmin) el.btnSwitchToAdmin.style.display = 'none';
    if (el.btnSwitchToUser) el.btnSwitchToUser.style.display = 'inline-flex';
    if (el.btnAdminLogout) el.btnAdminLogout.style.display = 'inline-flex';

    if (el.currentRoleBadge) {
      el.currentRoleBadge.textContent = '관리자 모드';
      el.currentRoleBadge.style.background = '#fef3c7';
      el.currentRoleBadge.style.color = '#b45309';
    }

    // 관리자 뷰 로드
    renderSignerTags();
    renderProgressTable();
    renderCompleteTable();
    updateCompleteTabUI();
    updateDashboardStats();
    syncConfigInputs();
    refreshAdminAndUserPreview();
  }

  function switchToUserView() {
    el.adminViewSection.style.display = 'none';
    el.userViewSection.style.display = 'block';

    if (state.isAdminLoggedIn) {
      if (el.btnSwitchToAdmin) el.btnSwitchToAdmin.style.display = 'inline-flex';
      if (el.btnSwitchToUser) el.btnSwitchToUser.style.display = 'none';
      if (el.currentRoleBadge) {
        el.currentRoleBadge.textContent = '사용자 모드 (관리자 접속 중)';
      }
    } else {
      if (el.currentRoleBadge) {
        el.currentRoleBadge.textContent = '사용자 모드';
        el.currentRoleBadge.style.background = 'var(--primary-light)';
        el.currentRoleBadge.style.color = 'var(--primary)';
      }
    }

    if (!state.currentSignerName) {
      el.userNameStep.style.display = 'block';
      el.userSigningStep.style.display = 'none';
      el.userCompleteStep.style.display = 'none';
    }
  }

  // 모달 로그인 (기존 모달 호환용)
  function openAdminLoginModal() {
    if (el.adminIdInput) el.adminIdInput.value = '';
    if (el.adminPwInput) el.adminPwInput.value = '';
    if (el.loginErrorAlert) el.loginErrorAlert.style.display = 'none';
    if (el.adminLoginModal) el.adminLoginModal.style.display = 'flex';
    if (el.adminIdInput) el.adminIdInput.focus();
  }

  function closeAdminLoginModal() {
    if (el.adminLoginModal) el.adminLoginModal.style.display = 'none';
  }

  function handleAdminLogin(e) {
    if (e) e.preventDefault();
    const inputId = (el.adminIdInput ? el.adminIdInput.value : '').trim();
    const inputPw = el.adminPwInput ? el.adminPwInput.value : '';

    const targetId = window.APP_CONFIG?.adminId || 'admin';
    const targetPw = window.APP_CONFIG?.adminPassword || 'admin4441#';

    if (inputId === targetId && inputPw === targetPw) {
      state.isAdminLoggedIn = true;
      try { sessionStorage.setItem('yewon_admin_logged_in', 'true'); } catch (err) {}
      updateLoginHeaderUI(true);
      closeAdminLoginModal();
      switchToAdminView();
      showToast('🔓 관리자로 로그인되었습니다.');
    } else {
      if (el.loginErrorAlert) el.loginErrorAlert.style.display = 'block';
      if (el.adminPwInput) {
        el.adminPwInput.value = '';
        el.adminPwInput.focus();
      }
    }
  }

  // 관리자 탭 전환 ([시작], [진행], [완료])
  function handleTabClick(btn) {
    const targetTabId = btn.getAttribute('data-tab');

    el.tabButtons.forEach(b => b.classList.remove('active'));
    el.tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const targetContent = document.getElementById(targetTabId);
    if (targetContent) {
      targetContent.classList.add('active');
    }

    if (targetTabId === 'tab-start') {
      refreshAdminAndUserPreview();
    } else if (targetTabId === 'tab-progress') {
      renderProgressTable();
      updateDashboardStats();
    } else if (targetTabId === 'tab-complete') {
      updateCompleteTabUI();
    }
  }

  // ==========================================================================
  // [10] 관리자 [시작] 메뉴 로직 (양식 업로드 & 대상자 관리)
  // ==========================================================================
  
  // 한국 주요 성씨 (100대 성씨)
  const KOREAN_SURNAMES = new Set([
    '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안',
    '송', '류', '유', '홍', '고', '문', '양', '손', '배', '백', '허', '남', '심', '노', '하', '곽', '성',
    '차', '주', '우', '구', '라', '전', '민', '진', '지', '엄', '채', '원', '천', '방', '공', '현', '함',
    '변', '염', '여', '추', '도', '소', '석', '선', '설', '마', '길', '연', '위', '표', '명', '기', '반',
    '왕', '금', '옥', '육', '인', '맹', '제', '모', '탁', '국', '어', '은', '편', '용', '예', '경', '봉'
  ]);

  // 문서 일반 단어 불용어 (성명 오인 방지)
  const EXCLUDED_WORDS = new Set([
    '서약서', '동의서', '확인서', '신청서', '계약서', '보안서', '각서', '안내서', '설명서', '보고서',
    '선생님', '담당자', '신청인', '서약자', '동의자', '대상자', '관계자', '관리자', '대표자', '확인자',
    '개인정보', '전자서명', '수집이용', '이용동의', '제공동의', '고유식별', '주민등록', '생년월일', '전화번호',
    '대한민국', '유효기간', '작성일자', '제출일자', '서명날인', '자필서명', '주의사항', '준수사항', '확인사항',
    '비밀유지', '업무보안', '안전관리', '정보보호', '처리방침', '학교장', '위원장', '부장교사', '교무부장',
    '서명란', '날인란', '도장날인', '페이지', '내용확인', '전체내용', '상기인', '본인은', '위사람', '위내용'
  ]);

  function isValidKoreanName(name) {
    if (!name || typeof name !== 'string') return false;
    name = name.trim();
    if (name.length < 2 || name.length > 4) return false;
    if (!/^[가-힣]+$/.test(name)) return false;
    if (EXCLUDED_WORDS.has(name)) return false;
    const firstChar = name.charAt(0);
    return KOREAN_SURNAMES.has(firstChar);
  }

  // PDF 문서 텍스트에서 서명 대상자 성명 자동 추출 엔진
  async function extractNamesFromPdf(pdfBytes) {
    if (!window.pdfjsLib || !pdfBytes) return [];
    try {
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      const pdf = await loadingTask.promise;
      const foundNames = new Set();
      let combinedAllText = '';

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items || [];
        const pageText = items.map(it => it.str).join(' ');
        combinedAllText += '\n' + pageText;

        // 패턴 1: 라벨 뒤에 이름이 오는 경우 (성명: 홍길동, 이름: 김철수, 서약자: 이영희 등)
        const labelRegexes = [
          /(?:성\s*명|이\s*름|서\s*약\s*자|신\s*청\s*인|동\s*의\s*자|대\s*상\s*자|교\s*사|선\s*생\s*님|담\s*당\s*자|성\s*함)\s*[:：\-_·\s]\s*([가-힣]{2,4})/g,
          /([가-힣]{2,4})\s*(?:\(인\)|\(서명\)|\(인장\)|\(자필\)|\(서명\/인\))/g,
          /(?:서\s*명|날\s*인)\s*[:：\s]\s*([가-힣]{2,4})/g,
          /([가-힣]{2,4})\s*(?:선생님|교사|귀하)/g,
          /(?:서약인|신청자|동의인|서명자)\s*([가-힣]{2,4})/g
        ];

        for (const reg of labelRegexes) {
          let match;
          while ((match = reg.exec(pageText)) !== null) {
            const candidate = match[1].trim();
            if (isValidKoreanName(candidate)) {
              foundNames.add(candidate);
            }
          }
        }
      }

      // 패턴 2: 표(Table) 또는 명단 목록 (1. 홍길동, 2. 김영희 등)
      const listRegex = /(?:[0-9]+[.)\s]|①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩)\s*([가-힣]{2,4})/g;
      let listMatch;
      while ((listMatch = listRegex.exec(combinedAllText)) !== null) {
        const candidate = listMatch[1].trim();
        if (isValidKoreanName(candidate)) {
          foundNames.add(candidate);
        }
      }

      return Array.from(foundNames);
    } catch (err) {
      console.warn('PDF 성명 자동 추출 중 오류:', err);
      return [];
    }
  }

  // PDF 양식 파일 업로드 처리
  async function handlePdfUpload(file) {
    if (!file || file.type !== 'application/pdf') {
      showToast('⚠️ PDF 형식의 파일만 업로드할 수 있습니다.');
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      state.pdfTemplate.name = file.name;
      state.pdfTemplate.bytes = bytes;
      state.isAutoFormMode = false;
      state.autoFormPositions = {};
      el.currentFormName.textContent = file.name;

      // IndexedDB에 저장
      await saveFileToDB('activeTemplate', bytes, file.name);

      // 관리자 뷰 및 사용자 뷰 미리보기 즉시 갱신
      refreshAdminAndUserPreview();

      // PDF 텍스트에서 서명 대상자 성명 자동 감지
      showToast('📄 PDF를 등록하고 문서 내 대상자 이름을 분석하는 중입니다...', 2500);
      const detectedNames = await extractNamesFromPdf(bytes);

      if (detectedNames && detectedNames.length > 0) {
        // 기존 기본 샘플 명단('홍길동', '김영희', '이철수', '박민수', '정수진')만 있는 경우 실제 감지된 명단으로 교체
        const defaultSampleNames = ['홍길동', '김영희', '이철수', '박민수', '정수진'];
        const isOnlyDefaults = state.signers.length === defaultSampleNames.length &&
          state.signers.every(s => defaultSampleNames.includes(s));

        if (isOnlyDefaults) {
          state.signers = [...detectedNames];
        } else {
          detectedNames.forEach(n => {
            if (!state.signers.includes(n)) {
              state.signers.push(n);
            }
          });
        }

        saveLocalSettings();
        renderSignerTags();
        renderProgressTable();
        updateDashboardStats();
        if (typeof saveConfigToFirestore === 'function') {
          saveConfigToFirestore();
        }

        showToast(`✨ PDF에서 ${detectedNames.length}명의 서명 대상자(${detectedNames.join(', ')})를 자동 인식하여 등록했습니다!`, 5000);
      } else {
        showToast(`📄 양식 파일 "${file.name}" 등록이 완료되었습니다. (문서에서 이름을 찾지 못해 기존 명단을 유지합니다)`, 4000);
      }
    } catch (err) {
      console.error('File upload error:', err);
      showToast('❌ 파일 처리 중 오류가 발생했습니다.');
    }
  }

  // 수동: 현재 등록된 PDF에서 대상자 성명 다시 추출하기
  async function handleManualAutoExtractNames() {
    if (!state.pdfTemplate.bytes) {
      showToast('⚠️ 먼저 PDF 양식 파일을 업로드해 주세요.');
      return;
    }

    showToast('🔍 PDF 문서 내 성명을 다시 분석하고 있습니다...', 2000);
    const detectedNames = await extractNamesFromPdf(state.pdfTemplate.bytes);

    if (detectedNames && detectedNames.length > 0) {
      let added = 0;
      detectedNames.forEach(n => {
        if (!state.signers.includes(n)) {
          state.signers.push(n);
          added++;
        }
      });

      saveLocalSettings();
      renderSignerTags();
      renderProgressTable();
      updateDashboardStats();
      if (typeof saveConfigToFirestore === 'function') {
        saveConfigToFirestore();
      }

      showToast(`✨ PDF에서 총 ${detectedNames.length}명 인식 완료! (신규 ${added}명 등록)`, 4000);
    } else {
      showToast('⚠️ 문서 내에서 성명 형식(예: 성명: 홍길동 등)을 찾지 못했습니다.');
    }
  }

  // ==========================================================================
  // [10-1] 자동 표 양식 생성 및 문서 반영
  // ==========================================================================
  async function applyAutoFormTemplate(showAlert = false) {
    try {
      const title = el.autoFormTitle ? el.autoFormTitle.value.trim() : (state.autoFormTitle || '');
      const dept = el.autoFormDept ? el.autoFormDept.value.trim() : (state.autoFormDept || '');

      state.autoFormTitle = title;
      state.autoFormDept = dept;
      state.isAutoFormMode = true;

      localStorage.setItem('yewon_auto_title', title);
      localStorage.setItem('yewon_auto_dept', dept);

      const autoPdfBytes = await generateAutoTablePdf(title, dept, state.signers);
      if (autoPdfBytes) {
        state.pdfTemplate.name = `${title || '서명 양식'}.pdf`;
        state.pdfTemplate.bytes = autoPdfBytes;
        state.cachedUnifiedPdfBytes = null; // 통합 문서 캐시 무효화

        if (el.currentFormName) {
          el.currentFormName.textContent = `${state.pdfTemplate.name} (2열 표 자동 생성본)`;
        }

        await saveFileToDB('activeTemplate', autoPdfBytes, state.pdfTemplate.name);
        refreshAdminAndUserPreview();
        saveDocumentsList();
        renderDocumentList();

        if (showAlert) {
          showToast(title ? `✨ "${title}" 2열 표 양식이 성공적으로 생성되어 적용되었습니다!` : '✨ 2열 표 양식이 성공적으로 생성되어 적용되었습니다!');
        }
      }
    } catch (err) {
      console.error('applyAutoFormTemplate error:', err);
      if (showAlert) {
        showToast('❌ 양식 자동 생성 중 오류가 발생했습니다.');
      }
    }
  }

  // ==========================================================================
  // [10-2] 다중 서류 관리 (작성된 서류 목록, 새 문서 생성, 수정, 삭제)
  // ==========================================================================

  // 서류 목록 로컬 로드
  function loadDocumentsList() {
    try {
      const raw = localStorage.getItem('yewon_docs_list');
      if (raw) {
        state.documents = JSON.parse(raw);
      }
    } catch (e) {
      state.documents = [];
    }

    if (!Array.isArray(state.documents) || state.documents.length === 0) {
      // 기존 단일 문서 데이터를 바탕으로 첫 번째 기본 문서 자동 생성 (임의 제목 없음)
      const defaultDoc = {
        id: 'doc_' + Date.now(),
        title: state.autoFormTitle || '',
        dept: state.autoFormDept || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        signers: [...state.signers],
        signatures: { ...state.signatures },
        isAutoFormMode: true
      };
      state.documents = [defaultDoc];
      saveDocumentsList();
    }

    if (!state.currentDocId || !state.documents.some(d => d.id === state.currentDocId)) {
      state.currentDocId = state.documents[0].id;
    }
  }

  // 현재 서류 목록 저장
  function saveDocumentsList() {
    try {
      // 현재 활성 문서의 실시간 상태 동기화
      const currentDoc = state.documents.find(d => d.id === state.currentDocId);
      if (currentDoc) {
        currentDoc.title = state.autoFormTitle || currentDoc.title;
        currentDoc.dept = state.autoFormDept !== undefined ? state.autoFormDept : currentDoc.dept;
        currentDoc.signers = [...state.signers];
        currentDoc.signatures = { ...state.signatures };
        currentDoc.isAutoFormMode = state.isAutoFormMode;
        currentDoc.updatedAt = new Date().toISOString();
      }

      // 메타데이터 리스트 로컬스토리지 저장
      const metaList = state.documents.map(d => ({
        id: d.id,
        title: d.title,
        dept: d.dept,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        signers: d.signers || [],
        signatures: d.signatures || {},
        isAutoFormMode: d.isAutoFormMode !== false
      }));
      localStorage.setItem('yewon_docs_list', JSON.stringify(metaList));

      // Realtime Database 클라우드 동기화 (모든 기기 실시간 전달)
      if (rtdb) {
        const docObj = {};
        metaList.forEach(d => {
          if (d.id) docObj[toSafeRtdbKey(d.id)] = d;
        });
        rtdb.ref('documents').set(docObj).catch(err => console.warn('RTDB docs 동기화 오류:', err));
      }
    } catch (e) {
      console.warn('saveDocumentsList error:', e);
    }
  }

  // 작성된 서류 목록 렌더링 (3개 초과 시 스크롤 처리)
  function renderDocumentList() {
    if (!el.docListContainer) return;
    el.docListContainer.innerHTML = '';
    if (el.docCountBadge) el.docCountBadge.textContent = `${state.documents.length}건`;

    if (state.documents.length === 0) {
      el.docListContainer.innerHTML = '<div style="padding: 1.25rem; text-align: center; color: #94a3b8; font-size: 0.9rem;">작성된 서류가 없습니다. 상단 [➕ 새 문서 만들기]를 눌러 새 서류를 작성해 보세요.</div>';
      return;
    }

    state.documents.forEach(doc => {
      const isActive = doc.id === state.currentDocId;
      const total = doc.signers ? doc.signers.length : 0;
      const completed = doc.signatures ? Object.keys(doc.signatures).length : 0;
      const isCompleted = total > 0 && completed >= total;
      const isPending = completed === 0;

      const item = document.createElement('div');
      item.className = `doc-item ${isActive ? 'active' : ''}`;
      item.style.cssText = `
        border: 1.5px solid ${isActive ? '#2563eb' : '#e2e8f0'};
        background: ${isActive ? '#eff6ff' : '#ffffff'};
        border-radius: var(--radius-md);
        padding: 0.75rem 1rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        transition: all 0.15s ease;
      `;

      let statusBadge = '';
      if (isCompleted) {
        statusBadge = `<span class="badge badge-success" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">✓ 서명 완료 (${completed}/${total}명)</span>`;
      } else if (isPending) {
        statusBadge = `<span class="badge badge-pending" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">대기 중 (0/${total}명)</span>`;
      } else {
        statusBadge = `<span class="badge" style="background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-size: 0.75rem; padding: 0.2rem 0.5rem;">⏳ 진행 중 (${completed}/${total}명)</span>`;
      }

      const updatedDate = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString('ko-KR') : '';

      item.innerHTML = `
        <div style="flex: 1; min-width: 0; cursor: pointer;" class="doc-item-click-area" data-id="${doc.id}">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.25rem;">
            <strong style="font-size: 0.95rem; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;">
              ${doc.title || '제목 없는 문서'}
            </strong>
            ${statusBadge}
            ${isActive ? '<span style="font-size: 0.7rem; background: #2563eb; color: white; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700;">작업 중</span>' : ''}
          </div>
          <div style="font-size: 0.8rem; color: #64748b; display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <span>🏢 ${doc.dept || '(부서/담당자 미지정)'}</span>
            <span>📅 ${updatedDate}</span>
          </div>
        </div>
        <div style="display: flex; gap: 0.4rem; flex-shrink: 0;">
          <button type="button" class="nav-link-btn primary btn-edit-doc" data-id="${doc.id}" style="font-size: 0.8rem; padding: 0.35rem 0.7rem; font-weight: 700;">
            ✏️ 수정
          </button>
          <button type="button" class="nav-link-btn danger btn-delete-doc" data-id="${doc.id}" style="font-size: 0.8rem; padding: 0.35rem 0.7rem;">
            🗑️ 삭제
          </button>
        </div>
      `;
      el.docListContainer.appendChild(item);
    });

    // [수정] 버튼 및 카드 클릭 이벤트 바인딩
    el.docListContainer.querySelectorAll('.btn-edit-doc, .doc-item-click-area').forEach(element => {
      element.addEventListener('click', (e) => {
        const id = element.getAttribute('data-id') || element.closest('.doc-item').querySelector('.btn-edit-doc').getAttribute('data-id');
        switchToDocument(id);
        const startTabBtn = document.querySelector('.tab-btn[data-tab="tab-start"]');
        if (startTabBtn) startTabBtn.click();
      });
    });

    // [삭제] 버튼 이벤트 바인딩
    el.docListContainer.querySelectorAll('.btn-delete-doc').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const doc = state.documents.find(d => d.id === id);
        const title = doc ? doc.title : '선택한 서류';
        if (confirm(`"${title}" 서류를 삭제하시겠습니까?\n(등록된 대상자 및 서명 데이터도 함께 삭제됩니다)`)) {
          deleteDocument(id);
        }
      });
    });
  }

  // 새 문서 만들기 (상단 [새 문서 만들기] 클릭 시)
  async function createNewDocument() {
    saveDocumentsList(); // 기존 작업 저장

    const newDocId = 'doc_' + Date.now();
    const now = new Date();
    const defaultTitle = ''; // 제목을 임의로 만들지 않고 빈칸으로 설정
    const defaultDept = '';  // 부서명도 빈칸으로 설정

    const newDoc = {
      id: newDocId,
      title: defaultTitle,
      dept: defaultDept,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      signers: ['홍길동', '김영희', '이철수', '박민수', '정수진'],
      signatures: {},
      isAutoFormMode: true
    };

    state.documents.unshift(newDoc); // 목록 최상단에 추가
    saveDocumentsList();
    await switchToDocument(newDocId);

    // [시작] 탭으로 전환
    const startTabBtn = document.querySelector('.tab-btn[data-tab="tab-start"]');
    if (startTabBtn) startTabBtn.click();

    // 제목 입력란 포커스
    if (el.autoFormTitle) {
      el.autoFormTitle.focus();
      el.autoFormTitle.select();
    }

    showToast('✨ 새 서류가 생성되었습니다. 제목과 명단을 작성해 주세요.');
  }

  // 특정 서류로 작업 전환
  async function switchToDocument(docId) {
    saveDocumentsList(); // 이전 문서 저장

    const doc = state.documents.find(d => d.id === docId);
    if (!doc) return;

    state.currentDocId = docId;
    state.autoFormTitle = doc.title || '';
    state.autoFormDept = doc.dept || '';
    state.signers = Array.isArray(doc.signers) ? [...doc.signers] : [];
    state.signatures = doc.signatures ? { ...doc.signatures } : {};
    state.isAutoFormMode = doc.isAutoFormMode !== false;
    state.cachedUnifiedPdfBytes = null;

    localStorage.setItem('yewon_auto_title', state.autoFormTitle);
    localStorage.setItem('yewon_auto_dept', state.autoFormDept);
    localStorage.setItem('yewon_signers', JSON.stringify(state.signers));
    saveLocalSettings();

    // UI 입력창 반영
    if (el.autoFormTitle) el.autoFormTitle.value = state.autoFormTitle;
    if (el.autoFormDept) el.autoFormDept.value = state.autoFormDept;

    // 모드 뷰 전환
    if (state.isAutoFormMode) {
      if (el.btnModeAutoForm) el.btnModeAutoForm.classList.add('primary');
      if (el.btnModeUploadPdf) el.btnModeUploadPdf.classList.remove('primary');
      if (el.sectionAutoForm) el.sectionAutoForm.style.display = 'block';
      if (el.sectionUploadPdf) el.sectionUploadPdf.style.display = 'none';

      // 2열 표 양식 자동 생성 및 바인딩
      const autoBytes = await generateAutoTablePdf(state.autoFormTitle, state.autoFormDept, state.signers);
      state.pdfTemplate.name = `${state.autoFormTitle}.pdf`;
      state.pdfTemplate.bytes = autoBytes;
    } else {
      if (el.btnModeUploadPdf) el.btnModeUploadPdf.classList.add('primary');
      if (el.btnModeAutoForm) el.btnModeAutoForm.classList.remove('primary');
      if (el.sectionAutoForm) el.sectionAutoForm.style.display = 'none';
      if (el.sectionUploadPdf) el.sectionUploadPdf.style.display = 'block';
    }

    if (el.currentFormName) {
      el.currentFormName.textContent = state.pdfTemplate.name;
    }

    renderDocumentList();
    renderSignerTags();
    renderProgressTable();
    renderCompleteTable();
    updateDashboardStats();
    updateCompleteTabUI();
    refreshAdminAndUserPreview();
  }

  // 서류 삭제
  async function deleteDocument(docId) {
    const idx = state.documents.findIndex(d => d.id === docId);
    if (idx === -1) return;

    state.documents.splice(idx, 1);

    if (state.documents.length === 0) {
      // 모두 삭제된 경우 새 기본 문서 생성
      await createNewDocument();
    } else {
      if (state.currentDocId === docId) {
        // 현재 활성 문서를 삭제한 경우 첫 번째 문서로 전환
        await switchToDocument(state.documents[0].id);
      } else {
        saveDocumentsList();
        renderDocumentList();
      }
    }
    showToast('🗑️ 서류가 삭제되었습니다.');
  }

  // 기본 양식으로 복원
  async function handleResetToDefaultForm() {
    if (!confirm('기본 표준 표 양식(제목 및 명단 기반)으로 복원하시겠습니까?')) return;
    await applyAutoFormTemplate(true);
  }

  // 등록된 선생님 대상자 태그 렌더링
  function renderSignerTags() {
    el.signerTagsList.innerHTML = '';
    el.signerCountBadge.textContent = state.signers.length;

    if (state.signers.length === 0) {
      el.signerTagsList.innerHTML = '<span style="color: #94a3b8; font-size: 0.85rem;">등록된 서명 대상자가 없습니다. 상단에서 선생님 성명을 추가해 주세요.</span>';
      return;
    }

    state.signers.forEach((name, idx) => {
      const tag = document.createElement('div');
      tag.className = 'signer-tag';
      tag.innerHTML = `
        <span>👤 ${name} 선생님</span>
        <button type="button" class="remove-signer-btn" data-index="${idx}" title="삭제">&times;</button>
      `;
      el.signerTagsList.appendChild(tag);
    });

    // 삭제 버튼 이벤트 바인딩
    el.signerTagsList.querySelectorAll('.remove-signer-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        state.signers.splice(index, 1);
        saveLocalSettings();
        renderSignerTags();
        renderProgressTable();
        updateDashboardStats();
        // 자동 양식 모드일 경우 명단 변경에 맞춰 실시간으로 표 양식 갱신
        if (state.isAutoFormMode) {
          applyAutoFormTemplate(false);
        } else {
          saveDocumentsList();
          renderDocumentList();
        }
      });
    });
  }

  // 대상자 추가
  function handleAddSigners() {
    const rawInput = el.newSignerInput.value.trim();
    if (!rawInput) return;

    // 쉼표, 줄바꿈, 띄어쓰기 구분 처리
    const names = rawInput
      .split(/[,/\n]+/)
      .map(n => n.trim())
      .filter(n => n.length > 0);

    let addedCount = 0;
    names.forEach(name => {
      // "선생님" 호칭이 붙어있으면 제거하고 성명만 저장
      const cleanName = name.replace(/선생님$/, '').trim();
      if (cleanName && !state.signers.includes(cleanName)) {
        state.signers.push(cleanName);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      saveLocalSettings();
      renderSignerTags();
      renderProgressTable();
      updateDashboardStats();
      el.newSignerInput.value = '';
      showToast(`${addedCount}명의 선생님이 등록되었습니다.`);

      // 자동 양식 모드일 경우 명단 추가에 맞춰 2열 표 양식 자동 재계산 및 갱신
      if (state.isAutoFormMode) {
        applyAutoFormTemplate(false);
      } else {
        saveDocumentsList();
        renderDocumentList();
      }
    } else {
      showToast('이미 등록되어 있거나 유효하지 않은 이름입니다.');
    }
  }

  // 전체 대상자 비우기
  function handleClearAllSigners() {
    if (confirm('등록된 대상자 명단을 모두 비우시겠습니까?')) {
      state.signers = [];
      saveLocalSettings();
      renderSignerTags();
      renderProgressTable();
      updateDashboardStats();
      showToast('대상자 명단이 비워졌습니다.');
      if (state.isAutoFormMode) {
        applyAutoFormTemplate(false);
      } else {
        saveDocumentsList();
        renderDocumentList();
      }
    }
  }

  // 관리자 양식 미리보기 및 사용자 미리보기 일괄 갱신
  function refreshAdminAndUserPreview() {
    if (state.pdfTemplate.bytes) {
      if (el.adminDocPagesContainer) {
        renderPdfToContainer(state.pdfTemplate.bytes, el.adminDocPagesContainer, {
          page: Number(state.sigPosition.page || 1),
          x: Number(state.sigPosition.x || 390),
          y: Number(state.sigPosition.y || 125),
          width: Number(state.sigPosition.width || 135),
          height: Number(state.sigPosition.height || 52),
          label: '✍️ 서명 날인 위치 (클릭하여 칸 이동 가능)'
        }, true);
      }
      if (el.userDocPagesContainer && !state.currentSignerName) {
        renderPdfToContainer(state.pdfTemplate.bytes, el.userDocPagesContainer);
      }
    }
  }

  // 서명 위치 및 설정값 저장
  function handleSaveStartConfig() {
    state.sigPosition.page = parseInt(el.sigPageInput.value, 10) || 1;
    state.sigPosition.x = parseInt(el.sigXInput.value, 10) || 390;
    state.sigPosition.y = parseInt(el.sigYInput.value, 10) || 125;
    state.sigPosition.width = parseInt(el.sigWidthInput.value, 10) || 135;
    state.sigPosition.height = parseInt(el.sigHeightInput.value, 10) || 52;

    saveLocalSettings();
    showToast('💾 서명 위치 및 환경 설정이 저장되었습니다.');

    // 미리보기 갱신
    refreshAdminAndUserPreview();
  }

  function syncConfigInputs() {
    if (el.sigPageInput) el.sigPageInput.value = state.sigPosition.page || 1;
    if (el.sigXInput) el.sigXInput.value = state.sigPosition.x || 390;
    if (el.sigYInput) el.sigYInput.value = state.sigPosition.y || 125;
    if (el.sigWidthInput) el.sigWidthInput.value = state.sigPosition.width || 135;
    if (el.sigHeightInput) el.sigHeightInput.value = state.sigPosition.height || 52;
  }

  // ==========================================================================
  // [11] 관리자 [진행] 메뉴 로직 (실시간 서명 현황 확인 및 게시)
  // ==========================================================================
  function renderProgressTable() {
    el.progressTableBody.innerHTML = '';

    if (state.signers.length === 0) {
      el.progressTableBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: #94a3b8; padding: 2.5rem;">
            등록된 서명 대상자가 없습니다. [시작] 메뉴에서 선생님을 추가해 주세요.
          </td>
        </tr>
      `;
      return;
    }

    state.signers.forEach((name, index) => {
      const record = state.signatures[name];
      const isSigned = !!record;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td><strong>${name}</strong> 선생님</td>
        <td>
          ${isSigned 
            ? '<span class="badge badge-success">✓ 서명 완료</span>' 
            : '<span class="badge badge-pending">대기 중</span>'}
        </td>
        <td>${isSigned ? record.signedAt : '-'}</td>
        <td style="text-align: center;">
          ${isSigned && record.signatureImage
            ? `<img src="${record.signatureImage}" class="sign-thumbnail" data-name="${name}" alt="서명" title="클릭하여 확대">`
            : '<span style="color: #cbd5e1; font-size: 0.85rem;">(미작성)</span>'}
        </td>
        <td style="text-align: right;">
          ${isSigned
            ? `<button type="button" class="nav-link-btn btn-reset-single-sign" data-name="${name}" style="color: #ef4444; border-color: #fecaca; font-size: 0.8rem; padding: 0.3rem 0.6rem;">서명 초기화</button>`
            : `<button type="button" class="nav-link-btn btn-copy-single-link" data-name="${name}" style="font-size: 0.8rem; padding: 0.3rem 0.6rem;">링크 복사</button>`}
        </td>
      `;
      el.progressTableBody.appendChild(tr);
    });

    // 썸네일 클릭 시 확대 보기
    el.progressTableBody.querySelectorAll('.sign-thumbnail').forEach(img => {
      img.addEventListener('click', (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        openSignatureModal(name);
      });
    });

    // 개별 서명 초기화 버튼
    el.progressTableBody.querySelectorAll('.btn-reset-single-sign').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        if (confirm(`${name} 선생님의 서명을 초기화하시겠습니까?`)) {
          delete state.signatures[name];
          await removeSignatureFromDB(name);
          renderProgressTable();
          renderCompleteTable();
          updateDashboardStats();
          showToast(`${name} 선생님의 서명이 초기화되었습니다.`);
        }
      });
    });

    // 개별 서명 링크 복사 버튼
    el.progressTableBody.querySelectorAll('.btn-copy-single-link').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        copySignerLink(name);
      });
    });
  }

  function updateDashboardStats() {
    const total = state.signers.length;
    let completed = 0;

    state.signers.forEach(name => {
      if (state.signatures[name]) completed++;
    });

    const pending = total - completed;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    el.statTotalSigners.textContent = total;
    el.statCompletedSigners.textContent = completed;
    el.statPendingSigners.textContent = pending;
    el.statProgressPercent.textContent = `${percent}%`;
  }

  // 사용자 서명 링크 복사
  function copySignerLink(specificName = null) {
    let url;
    try {
      url = new URL(window.location.href);
    } catch (e) {
      url = new URL(window.location.pathname, window.location.origin);
    }
    url.searchParams.delete('admin');
    if (state.currentDocId) {
      url.searchParams.set('doc', state.currentDocId);
    }
    if (specificName) {
      url.searchParams.set('name', specificName);
    } else {
      url.searchParams.delete('name');
    }

    const isFile = window.location.protocol === 'file:';
    const linkStr = url.toString();

    navigator.clipboard.writeText(linkStr).then(() => {
      let msg = specificName
        ? `🔗 ${specificName} 선생님 전용 서명 링크가 복사되었습니다!`
        : '🔗 사용자 서명 링크가 복사되었습니다!';
      if (isFile) {
        msg += '\n\n(💡 알림: 현재 내 컴퓨터 로컬 파일(file://)로 실행 중입니다. 다른 PC/스마트폰에서 접속 시에는 웹 주소 또는 네트워크 공유 주소를 사용해 주세요)';
      }
      showToast(msg);
    }).catch(() => {
      prompt('서명 링크 주소입니다. 복사하여 전달해 주세요:', linkStr);
    });
  }

  // ==========================================================================
  // [12] 관리자 [완료] 메뉴 로직 (출력 방식 선택: 1. 한 장 통합 출력 / 2. 개인별 출력)
  // ==========================================================================

  // 출력 모드 변경 ('allInOne' or 'individual')
  function setOutputMode(mode) {
    state.currentOutputMode = mode;
    updateCompleteTabUI();
  }

  // [완료] 탭 전체 UI 업데이트
  async function updateCompleteTabUI() {
    const isAllInOne = (state.currentOutputMode === 'allInOne');

    if (el.radioModeAllInOne) el.radioModeAllInOne.checked = isAllInOne;
    if (el.radioModeIndividual) el.radioModeIndividual.checked = !isAllInOne;

    if (el.modeCardAllInOne) el.modeCardAllInOne.classList.toggle('active', isAllInOne);
    if (el.modeCardIndividual) el.modeCardIndividual.classList.toggle('active', !isAllInOne);

    if (el.completeSectionAllInOne) el.completeSectionAllInOne.style.display = isAllInOne ? 'block' : 'none';
    if (el.completeSectionIndividual) el.completeSectionIndividual.style.display = !isAllInOne ? 'block' : 'none';

    if (isAllInOne) {
      await renderUnifiedDocumentView();
    } else {
      renderCompleteTable();
    }
  }

  // 1) 모든 사용자 서명을 한 장에 기재하여 미리보기 표시
  async function renderUnifiedDocumentView() {
    if (!el.unifiedDocPagesContainer) return;

    const totalSigners = state.signers.length;
    const completedSigners = state.signers.filter(name => !!state.signatures[name]);
    if (el.unifiedSignCountBadge) {
      el.unifiedSignCountBadge.textContent = `✍️ 서명 완료: ${completedSigners.length}명 / 전체 대상자: ${totalSigners}명`;
    }

    el.unifiedDocPagesContainer.innerHTML = '<div style="padding: 2.5rem; text-align: center; color: #64748b;">⏳ 모든 사용자 서명을 취합한 통합 문서를 생성 중입니다...</div>';

    try {
      const unifiedBytes = await generateUnifiedPdf();
      state.cachedUnifiedPdfBytes = unifiedBytes;
      await renderPdfToContainer(unifiedBytes, el.unifiedDocPagesContainer, null, false);
    } catch (err) {
      console.error('Unified document render error:', err);
      el.unifiedDocPagesContainer.innerHTML = '<div style="padding: 2.5rem; text-align: center; color: #ef4444;">통합 서명 문서를 불러오지 못했습니다.</div>';
    }
  }

  // 1-1) 통합본 즉시 인쇄
  async function handlePrintUnifiedPdf() {
    try {
      showToast('🖨️ 통합 서명 문서 인쇄 준비 중...');
      const unifiedBytes = await generateUnifiedPdf();
      state.cachedUnifiedPdfBytes = unifiedBytes;
      printPdfBytes(unifiedBytes, `[통합서명완료]_${state.pdfTemplate.name || '서약서'}`);
    } catch (err) {
      console.error('Print unified PDF error:', err);
      showToast('❌ 통합 문서 인쇄 중 오류가 발생했습니다.');
    }
  }

  // 1-2) 통합본 PDF 다운로드
  async function handleDownloadUnifiedPdf() {
    try {
      showToast('📥 통합 서명 문서 다운로드 준비 중...');
      const unifiedBytes = await generateUnifiedPdf();
      state.cachedUnifiedPdfBytes = unifiedBytes;
      const filename = `[통합서명완료]_모든사용자_${state.pdfTemplate.name || '서약서.pdf'}`;
      downloadPdfBytes(unifiedBytes, filename);
    } catch (err) {
      console.error('Download unified PDF error:', err);
      showToast('❌ 통합 문서 다운로드 중 오류가 발생했습니다.');
    }
  }

  // 1-3) 통합본 전체화면 미리보기 모달
  async function handlePreviewUnifiedPdf() {
    try {
      showToast('👁️ 통합 서명 문서 미리보기 준비 중...');
      const unifiedBytes = await generateUnifiedPdf();
      state.cachedUnifiedPdfBytes = unifiedBytes;
      openPdfPreviewModal(`[통합 서명 완료본] ${state.pdfTemplate.name || '서약서'}`, unifiedBytes);
    } catch (err) {
      console.error('Preview unified PDF error:', err);
      showToast('❌ 통합 문서 미리보기 중 오류가 발생했습니다.');
    }
  }

  // 2) 사용자 개인별 테이블 렌더링
  function renderCompleteTable() {
    if (!el.completeTableBody) return;
    el.completeTableBody.innerHTML = '';

    const completedSigners = state.signers.filter(name => !!state.signatures[name]);

    if (completedSigners.length === 0) {
      el.completeTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #94a3b8; padding: 2.5rem;">
            서명이 완료된 문서가 아직 없습니다.
          </td>
        </tr>
      `;
      return;
    }

    completedSigners.forEach((name, index) => {
      const record = state.signatures[name];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td><strong>${name}</strong> 선생님</td>
        <td>${record.signedAt}</td>
        <td>${state.pdfTemplate.name || '서약서 양식.pdf'}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end;">
            <button type="button" class="nav-link-btn btn-print-user-pdf" data-name="${name}" title="이 사용자의 서명 문서를 즉시 인쇄합니다">
              🖨️ 인쇄
            </button>
            <button type="button" class="nav-link-btn btn-preview-signed-pdf" data-name="${name}">
              👁️ 미리보기
            </button>
            <button type="button" class="nav-link-btn primary btn-download-signed-pdf" data-name="${name}">
              📥 PDF 다운로드
            </button>
          </div>
        </td>
      `;
      el.completeTableBody.appendChild(tr);
    });

    // 개별 PDF 즉시 인쇄 이벤트
    el.completeTableBody.querySelectorAll('.btn-print-user-pdf').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        const record = state.signatures[name];
        if (record) {
          const pdfBytes = record.pdfBytes || await generateSignedPdf(name, record.signatureImage);
          printPdfBytes(pdfBytes, `[서명완료]_${name}_${state.pdfTemplate.name || '서약서'}`);
        }
      });
    });

    // 개별 PDF 다운로드 이벤트
    el.completeTableBody.querySelectorAll('.btn-download-signed-pdf').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        const record = state.signatures[name];
        if (record) {
          const pdfBytes = record.pdfBytes || await generateSignedPdf(name, record.signatureImage);
          const filename = `[서명완료]_${name}_${state.pdfTemplate.name || '서약서.pdf'}`;
          downloadPdfBytes(pdfBytes, filename);
        }
      });
    });

    // 개별 PDF 미리보기 이벤트
    el.completeTableBody.querySelectorAll('.btn-preview-signed-pdf').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const name = e.currentTarget.getAttribute('data-name');
        const record = state.signatures[name];
        if (record) {
          const pdfBytes = record.pdfBytes || await generateSignedPdf(name, record.signatureImage);
          openPdfPreviewModal(`[서명완료] ${name} 선생님 서명 문서`, pdfBytes);
        }
      });
    });
  }

  // 2-1) 개인별 전체 일괄 인쇄 (모든 개별 완료 문서를 순차 병합하여 일괄 인쇄)
  async function handlePrintAllIndividual() {
    const completedSigners = state.signers.filter(name => !!state.signatures[name]);
    if (completedSigners.length === 0) {
      showToast('⚠️ 인쇄할 서명 완료 문서가 없습니다.');
      return;
    }
    if (!window.PDFLib) {
      showToast('PDFLib 로딩 중입니다...');
      return;
    }

    try {
      showToast(`🖨️ 총 ${completedSigners.length}명의 개별 문서를 일괄 인쇄 준비 중입니다...`);
      const { PDFDocument } = window.PDFLib;
      const mergedPdf = await PDFDocument.create();

      for (const name of completedSigners) {
        const record = state.signatures[name];
        if (record) {
          const pdfBytes = record.pdfBytes || await generateSignedPdf(name, record.signatureImage);
          const doc = await PDFDocument.load(pdfBytes.slice());
          const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
          copiedPages.forEach(page => mergedPdf.addPage(page));
        }
      }

      const mergedBytes = await mergedPdf.save();
      printPdfBytes(mergedBytes, `[개별서명모음인쇄]_총${completedSigners.length}명`);
    } catch (err) {
      console.error('Print all individual error:', err);
      showToast('❌ 일괄 인쇄 처리 중 오류가 발생했습니다.');
    }
  }

  // 전체 완료 PDF 일괄 다운로드 (ZIP)
  async function handleDownloadAllPdfZip() {
    const completedSigners = state.signers.filter(name => !!state.signatures[name]);
    if (completedSigners.length === 0) {
      showToast('⚠️ 다운로드할 서명 완료 문서가 없습니다.');
      return;
    }

    if (!window.JSZip) {
      showToast('JSZip 압축 라이브러리를 로드하는 중입니다...');
      return;
    }

    el.btnDownloadAllPdfZip.disabled = true;
    el.btnDownloadAllPdfZip.textContent = '⏳ 압축 파일 생성 중...';

    try {
      const zip = new JSZip();
      const folder = zip.folder('예원전자서명_완료문서모음');

      for (const name of completedSigners) {
        const record = state.signatures[name];
        if (record) {
          const pdfBytes = record.pdfBytes || await generateSignedPdf(name, record.signatureImage);
          const fileName = `[서명완료]_${name}_${state.pdfTemplate.name || '서약서.pdf'}`;
          folder.file(fileName, pdfBytes);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(zipBlob);
      link.download = `[전체완료]_예원전자서명_문서모음_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(link.href);

      showToast(`📦 총 ${completedSigners.length}건의 서명 완료 문서를 일괄 다운로드했습니다.`);
    } catch (err) {
      console.error('ZIP generation error:', err);
      showToast('❌ 압축 파일 생성 중 오류가 발생했습니다.');
    } finally {
      el.btnDownloadAllPdfZip.disabled = false;
      el.btnDownloadAllPdfZip.textContent = '📦 전체 완료 문서 일괄 다운로드 (ZIP)';
    }
  }

  // PDF 바이트 다운로드 헬퍼
  function downloadPdfBytes(bytes, filename) {
    if (!filename.endsWith('.pdf')) filename += '.pdf';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    showToast(`📥 ${filename} 다운로드를 시작했습니다.`);
  }

  // ==========================================================================
  // [13] 모달 창 제어 (서명 확대 모달 & PDF 미리보기 모달)
  // ==========================================================================
  function openSignatureModal(name) {
    const record = state.signatures[name];
    if (!record) return;

    el.sigModalTitle.textContent = `${name} 선생님 전자서명 원본`;
    el.sigModalDate.textContent = `서명 일시: ${record.signedAt}`;
    el.sigModalImage.src = record.signatureImage;
    el.signatureViewModal.style.display = 'flex';
  }

  function closeSignatureModal() {
    el.signatureViewModal.style.display = 'none';
  }

  function openPdfPreviewModal(title, pdfBytes) {
    el.pdfPreviewModalTitle.textContent = title;
    el.pdfPreviewModal.style.display = 'flex';
    renderPdfToContainer(pdfBytes, el.modalPdfPagesContainer);
  }

  function closePdfPreviewModal() {
    el.pdfPreviewModal.style.display = 'none';
    el.modalPdfPagesContainer.innerHTML = '';
  }

  // ==========================================================================
  // [14] 이벤트 리스너 등록
  // ==========================================================================
  function setupEventListeners() {
    // 헤더 및 네비게이션
    if (el.brandLogo) {
      el.brandLogo.addEventListener('click', (e) => {
        e.preventDefault();
        switchToUserView();
      });
    }

    // 상단 우측 아담한 관리자 로그인 폼 및 버튼 리스너
    if (el.headerAdminLoginForm) {
      el.headerAdminLoginForm.addEventListener('submit', handleHeaderLogin);
    }
    if (el.btnHeaderLogin) {
      el.btnHeaderLogin.addEventListener('click', handleHeaderLogin);
    }
    if (el.headerAdminPw) {
      el.headerAdminPw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleHeaderLogin(e);
      });
    }
    if (el.headerAdminId) {
      el.headerAdminId.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (el.headerAdminPw) el.headerAdminPw.focus();
          else handleHeaderLogin(e);
        }
      });
    }

    // 관리자 바 버튼 (사용자 화면 전환, 관리자 대시보드 복귀, 로그아웃)
    if (el.btnSwitchToUser) el.btnSwitchToUser.addEventListener('click', switchToUserView);
    if (el.btnSwitchToAdmin) el.btnSwitchToAdmin.addEventListener('click', switchToAdminView);
    if (el.btnAdminLogout) el.btnAdminLogout.addEventListener('click', handleAdminLogout);

    // 모달 관리자 로그인 (호환)
    if (el.btnAdminAccess) el.btnAdminAccess.addEventListener('click', openAdminLoginModal);
    if (el.btnCloseLoginModal) el.btnCloseLoginModal.addEventListener('click', closeAdminLoginModal);
    if (el.adminLoginForm) el.adminLoginForm.addEventListener('submit', handleAdminLogin);

    // 관리자 탭
    el.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => handleTabClick(btn));
    });

    // 상단 [새 문서 만들기] 버튼
    if (el.btnCreateNewDoc) {
      el.btnCreateNewDoc.addEventListener('click', createNewDocument);
    }

    // 관리자: [시작] 메뉴 - 양식 모드 전환 (1. 자동 표 생성 / 2. PDF 직접 업로드)
    if (el.btnModeAutoForm && el.btnModeUploadPdf) {
      el.btnModeAutoForm.addEventListener('click', () => {
        el.btnModeAutoForm.classList.add('primary');
        el.btnModeUploadPdf.classList.remove('primary');
        if (el.sectionAutoForm) el.sectionAutoForm.style.display = 'block';
        if (el.sectionUploadPdf) el.sectionUploadPdf.style.display = 'none';
        state.isAutoFormMode = true;
        applyAutoFormTemplate(false);
      });

      el.btnModeUploadPdf.addEventListener('click', () => {
        el.btnModeUploadPdf.classList.add('primary');
        el.btnModeAutoForm.classList.remove('primary');
        if (el.sectionAutoForm) el.sectionAutoForm.style.display = 'none';
        if (el.sectionUploadPdf) el.sectionUploadPdf.style.display = 'block';
        state.isAutoFormMode = false;
      });
    }

    // 양식 자동 생성 버튼 및 입력창 이벤트
    if (el.btnGenerateAutoForm) {
      el.btnGenerateAutoForm.addEventListener('click', () => applyAutoFormTemplate(true));
    }
    if (el.autoFormTitle) {
      el.autoFormTitle.value = state.autoFormTitle || '';
      el.autoFormTitle.addEventListener('change', () => applyAutoFormTemplate(false));
      el.autoFormTitle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyAutoFormTemplate(true);
      });
    }
    if (el.autoFormDept) {
      el.autoFormDept.value = state.autoFormDept || '';
      el.autoFormDept.addEventListener('change', () => applyAutoFormTemplate(false));
      el.autoFormDept.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyAutoFormTemplate(true);
      });
    }

    // 관리자: [시작] 메뉴 - 드롭존 및 버튼
    if (el.pdfDropzone && el.pdfFileInput) {
      el.pdfDropzone.addEventListener('click', () => el.pdfFileInput.click());
      el.pdfFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          handlePdfUpload(e.target.files[0]);
        }
      });

      // 드래그 앤 드롭
      el.pdfDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.pdfDropzone.style.borderColor = '#1d4ed8';
        el.pdfDropzone.style.background = '#e0e7ff';
      });
      el.pdfDropzone.addEventListener('dragleave', () => {
        el.pdfDropzone.style.borderColor = '';
        el.pdfDropzone.style.background = '';
      });
      el.pdfDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        el.pdfDropzone.style.borderColor = '';
        el.pdfDropzone.style.background = '';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handlePdfUpload(e.dataTransfer.files[0]);
        }
      });
    }

    if (el.btnAutoExtractNames) el.btnAutoExtractNames.addEventListener('click', handleManualAutoExtractNames);
    if (el.btnPreviewCurrentForm) {
      el.btnPreviewCurrentForm.addEventListener('click', () => {
        if (state.pdfTemplate.bytes) {
          openPdfPreviewModal(`양식 미리보기: ${state.pdfTemplate.name}`, state.pdfTemplate.bytes);
        } else {
          showToast('미리 볼 양식이 아직 준비되지 않았습니다.');
        }
      });
    }
    if (el.btnResetToDefaultForm) el.btnResetToDefaultForm.addEventListener('click', handleResetToDefaultForm);

    if (el.btnAddSigners) el.btnAddSigners.addEventListener('click', handleAddSigners);
    if (el.newSignerInput) {
      el.newSignerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAddSigners();
      });
    }
    if (el.btnClearAllSigners) el.btnClearAllSigners.addEventListener('click', handleClearAllSigners);
    if (el.btnSaveStartConfig) el.btnSaveStartConfig.addEventListener('click', handleSaveStartConfig);

    // 서명 위치 빠른 프리셋 버튼 (칸 맞춤)
    if (el.btnPresetDefault) {
      el.btnPresetDefault.addEventListener('click', () => {
        state.sigPosition.x = 390;
        state.sigPosition.y = 125;
        state.sigPosition.width = 135;
        state.sigPosition.height = 52;
        syncConfigInputs();
        saveLocalSettings();
        refreshAdminAndUserPreview();
        showToast('🎯 기본 서명란 칸 맞춤(135×52)이 적용되었습니다.');
      });
    }

    if (el.btnPresetTableSmall) {
      el.btnPresetTableSmall.addEventListener('click', () => {
        state.sigPosition.width = 75;
        state.sigPosition.height = 24;
        syncConfigInputs();
        saveLocalSettings();
        refreshAdminAndUserPreview();
        showToast('📋 표 양식 소형 칸 맞춤(75×24)이 적용되었습니다.');
      });
    }

    if (el.btnPresetTableMed) {
      el.btnPresetTableMed.addEventListener('click', () => {
        state.sigPosition.width = 105;
        state.sigPosition.height = 32;
        syncConfigInputs();
        saveLocalSettings();
        refreshAdminAndUserPreview();
        showToast('📋 표 양식 중형 칸 맞춤(105×32)이 적용되었습니다.');
      });
    }

    // 좌표/크기 수동 입력 시 실시간 미리보기 갱신
    ['sigPageInput', 'sigXInput', 'sigYInput', 'sigWidthInput', 'sigHeightInput'].forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', () => {
          state.sigPosition.page = parseInt(el.sigPageInput.value, 10) || 1;
          state.sigPosition.x = parseInt(el.sigXInput.value, 10) || 390;
          state.sigPosition.y = parseInt(el.sigYInput.value, 10) || 125;
          state.sigPosition.width = parseInt(el.sigWidthInput.value, 10) || 135;
          state.sigPosition.height = parseInt(el.sigHeightInput.value, 10) || 52;
          refreshAdminAndUserPreview();
        });
      }
    });

    // 관리자: [진행] 메뉴
    if (el.btnCopyUserSignLink) el.btnCopyUserSignLink.addEventListener('click', () => copySignerLink());
    if (el.btnRefreshProgress) {
      el.btnRefreshProgress.addEventListener('click', () => {
        renderProgressTable();
        updateDashboardStats();
        showToast('🔄 서명 현황이 새로고침되었습니다.');
      });
    }

    // 관리자: [완료] 메뉴 (출력 모드 전환 및 액션 버튼)
    if (el.radioModeAllInOne) {
      el.radioModeAllInOne.addEventListener('change', () => setOutputMode('allInOne'));
    }
    if (el.radioModeIndividual) {
      el.radioModeIndividual.addEventListener('change', () => setOutputMode('individual'));
    }
    if (el.modeCardAllInOne) {
      el.modeCardAllInOne.addEventListener('click', (e) => {
        if (e.target !== el.radioModeAllInOne) {
          setOutputMode('allInOne');
        }
      });
    }
    if (el.modeCardIndividual) {
      el.modeCardIndividual.addEventListener('click', (e) => {
        if (e.target !== el.radioModeIndividual) {
          setOutputMode('individual');
        }
      });
    }

    // 1) 통합본 액션 버튼
    if (el.btnPrintUnifiedPdf) el.btnPrintUnifiedPdf.addEventListener('click', handlePrintUnifiedPdf);
    if (el.btnDownloadUnifiedPdf) el.btnDownloadUnifiedPdf.addEventListener('click', handleDownloadUnifiedPdf);
    if (el.btnPreviewUnifiedPdf) el.btnPreviewUnifiedPdf.addEventListener('click', handlePreviewUnifiedPdf);

    // 2) 개인별 액션 버튼
    if (el.btnPrintAllIndividual) el.btnPrintAllIndividual.addEventListener('click', handlePrintAllIndividual);
    if (el.btnDownloadAllPdfZip) el.btnDownloadAllPdfZip.addEventListener('click', handleDownloadAllPdfZip);

    // 사용자 화면: 성명 입력 및 서명
    if (el.btnCheckName) el.btnCheckName.addEventListener('click', handleCheckSignerName);
    if (el.signerNameInput) {
      el.signerNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleCheckSignerName();
      });
    }
    if (el.btnReenterName) el.btnReenterName.addEventListener('click', handleReenterName);

    // 요구사항 버튼 2개: [다시 하기], [제출]
    if (el.btnResetSign) el.btnResetSign.addEventListener('click', clearSignatureCanvas);
    if (el.btnSubmitSign) el.btnSubmitSign.addEventListener('click', handleSubmitSignature);

    // 완료 화면
    if (el.btnDownloadMySignedPdf) el.btnDownloadMySignedPdf.addEventListener('click', handleDownloadMySignedPdf);
    if (el.btnRestartUserFlow) el.btnRestartUserFlow.addEventListener('click', handleRestartUserFlow);

    // 모달 닫기
    if (el.btnCloseSignatureModal) el.btnCloseSignatureModal.addEventListener('click', closeSignatureModal);
    if (el.btnCloseSigModalBtn) el.btnCloseSigModalBtn.addEventListener('click', closeSignatureModal);
    if (el.btnClosePdfPreviewModal) el.btnClosePdfPreviewModal.addEventListener('click', closePdfPreviewModal);

    // 바깥 클릭 시 모달 닫기
    window.addEventListener('click', (e) => {
      if (e.target === el.adminLoginModal) closeAdminLoginModal();
      if (e.target === el.signatureViewModal) closeSignatureModal();
      if (e.target === el.pdfPreviewModal) closePdfPreviewModal();
    });

    // 창 크기 변경 시 서명 캔버스 재조정
    window.addEventListener('resize', () => {
      if (el.userSigningStep && el.userSigningStep.style.display !== 'none' && !hasDrawn) {
        initSignatureCanvas();
      }
    });
  }

  // ==========================================================================
  // [15] 시스템 초기화 및 시작
  // ==========================================================================
  async function bootstrap() {
    // 1. 이벤트 리스너 즉시 바인딩 (UI 클릭 및 로그인이 절대 먹통되지 않도록 최우선 실행)
    setupEventListeners();
    loadLocalSettings();
    loadDocumentsList();
    renderDocumentList();
    renderSignerTags();
    renderProgressTable();
    renderCompleteTable();
    updateDashboardStats();
    syncConfigInputs();

    // 2. 관리자 세션 복원 (새로고침 시 유지)
    try {
      if (sessionStorage.getItem('yewon_admin_logged_in') === 'true') {
        state.isAdminLoggedIn = true;
        updateLoginHeaderUI(true);
        switchToAdminView();
      }
    } catch (err) {}

    // 3. 비동기 데이터베이스 및 양식 로드 (오류 발생해도 UI 동작 보장)
    try {
      initFirebase();
      await initDB();

      // 저장된 양식 파일 불러오기
      const savedTemplate = await getFileFromDB('activeTemplate');
      if (savedTemplate && savedTemplate.data) {
        state.pdfTemplate.name = savedTemplate.name || '등록된 양식.pdf';
        state.pdfTemplate.bytes = savedTemplate.data;
        if (el.currentFormName) el.currentFormName.textContent = state.pdfTemplate.name;

        // 자동 양식인 경우 사전 좌표 계산 복원
        if (state.pdfTemplate.name.includes('자동 생성') || state.pdfTemplate.name.includes('서약서')) {
          state.isAutoFormMode = true;
          await generateAutoTablePdf(state.autoFormTitle, state.autoFormDept, state.signers);
        } else {
          state.isAutoFormMode = false;
        }
      } else {
        // 기본 표 양식 자동 생성 (2열 표 구조)
        const defaultBytes = await generateDefaultPdfTemplate();
        if (defaultBytes) {
          state.pdfTemplate.name = `${state.autoFormTitle || '서명 양식'}.pdf`;
          state.pdfTemplate.bytes = defaultBytes;
          if (el.currentFormName) el.currentFormName.textContent = `${state.pdfTemplate.name} (2열 표 자동 생성본)`;
          await saveFileToDB('activeTemplate', defaultBytes, state.pdfTemplate.name);
        }
      }

      // 저장된 서명 레코드들 불러오기
      const savedSignatures = await getAllSignaturesFromDB();
      savedSignatures.forEach(rec => {
        state.signatures[rec.name] = rec;
      });

      renderProgressTable();
      renderCompleteTable();
      updateCompleteTabUI();
      updateDashboardStats();
      refreshAdminAndUserPreview();
      renderDocumentList();
    } catch (dbErr) {
      console.warn('Bootstrap background storage load skipped:', dbErr);
    }

    // 4. URL 파라미터 확인 (예: ?doc=docId or ?name=홍길동 or ?admin=true)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const targetDocId = urlParams.get('doc');
      if (targetDocId && state.documents && state.documents.some(d => d.id === targetDocId)) {
        await switchToDocument(targetDocId);
      }
      const directName = urlParams.get('name');
      if (directName && el.signerNameInput) {
        el.signerNameInput.value = directName;
        // 약간의 여유를 주어 클라우드 동기화와 조율
        setTimeout(() => {
          handleCheckSignerName();
        }, 100);
      } else if (urlParams.get('admin') === 'true') {
        if (el.headerAdminPw) el.headerAdminPw.focus();
      }
    } catch (paramErr) {}
  }

  // DOM 로드 완료 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  } catch (globalAppError) {
    console.error('FATAL APP.JS ERROR:', globalAppError);
    var d = document.createElement('div');
    d.id = 'FATAL_APP_ERROR';
    d.style.cssText = 'background:red;color:white;padding:20px;font-size:16px;position:fixed;top:0;left:0;z-index:999999;';
    d.textContent = '치명적 스크립트 오류: ' + (globalAppError ? (globalAppError.stack || globalAppError.message || globalAppError) : '알 수 없음');
    document.body.appendChild(d);
  }

})();
