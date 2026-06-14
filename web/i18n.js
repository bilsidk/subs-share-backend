/* SubsShare Web — i18n. 15 languages, same list as the mobile app.
   Detects the browser language (exact tag -> base code -> zh special-case),
   falls back to English, and persists the user's choice in localStorage. */
'use strict';

// Same list/order as the mobile app's SUPPORTED_LANGUAGES
const LANGS = {
  en:      { native: 'English',              cc: 'gb', rtl: false },
  ar:      { native: 'العربية',               cc: 'sa', rtl: true  },
  fr:      { native: 'Français',              cc: 'fr', rtl: false },
  es:      { native: 'Español',               cc: 'es', rtl: false },
  pt:      { native: 'Português',             cc: 'br', rtl: false },
  tr:      { native: 'Türkçe',                cc: 'tr', rtl: false },
  id:      { native: 'Bahasa Indonesia',      cc: 'id', rtl: false },
  hi:      { native: 'हिन्दी',                  cc: 'in', rtl: false },
  ru:      { native: 'Русский',               cc: 'ru', rtl: false },
  de:      { native: 'Deutsch',               cc: 'de', rtl: false },
  'zh-CN': { native: '简体中文',                cc: 'cn', rtl: false },
  'zh-TW': { native: '繁體中文',                cc: 'tw', rtl: false },
  bn:      { native: 'বাংলা',                  cc: 'bd', rtl: false },
  ja:      { native: '日本語',                  cc: 'jp', rtl: false },
  ko:      { native: '한국어',                  cc: 'kr', rtl: false },
};

const T = {
  en: {
    common: { privacy: 'Privacy', terms: 'Terms', done: 'Done', cancel: 'Cancel', requestFailed: 'Request failed', sessionExpired: 'Session expired — sign in again.' },
    login: { tagline: 'Earn coins by supporting other creators.<br>Spend them to grow your channel.', continue: 'Continue with Google', signingIn: 'Signing in…', disclaimer: 'We use your Google account to verify YouTube actions.', cancelled: 'Sign-in cancelled.', closed: 'Sign-in was closed.', loading: 'Google sign-in is still loading — try again in a second.' },
    tabs: { home: 'Home', earn: 'Earn', grow: 'Grow', wallet: 'Wallet', profile: 'Profile' },
    home: { balance: 'Your balance', coinHint: 'Complete tasks, earn more coins', campaigns: 'Campaigns', completed: 'Completed', earnCoins: '📋 Earn coins', getSubs: '📈 Grow', recentActivity: 'Recent activity', noTransactions: 'No transactions yet' },
    earn: { title: 'Earn Coins', all: 'All', none: 'No tasks right now.', checkBack: 'Pull down or check back soon!', left: 'left', min: 'min' },
    task: { subscribe: 'Subscribe', like: 'Like', like_comment: 'Like + Comment', subscribe_like: 'Sub + Like', watch: 'Watch' },
    steps: {
      subscribe: '1. Open the channel on YouTube<br>2. Tap <b>Subscribe</b><br>3. Come back and verify',
      like: '1. Open the video on YouTube<br>2. Tap <b>👍 Like</b><br>3. Come back and verify',
      like_comment: '1. Open the video<br>2. Tap <b>👍 Like</b> and leave a <b>comment</b> (bonus coins!)<br>3. Come back and verify',
      subscribe_like: '1. Open the video<br>2. <b>Subscribe</b> to the channel and <b>Like</b> the video<br>3. Come back and verify',
      watch: '1. Open the video<br>2. Watch at least <b>{{min}} minute(s)</b><br>3. Come back and verify',
    },
    modal: { open: '▶ Open YouTube', verify: 'Verify & Claim', verifying: 'Verifying…', verifyIn: 'Verify ({{s}}s)', openFirst: 'Open YouTube first — the timer starts when you do.', waitMore: 'Wait {{s}}s more, then verify.', done: 'Done' },
    grow: { title: 'Grow', type: 'Campaign type', videoUrl: 'Your video URL', minutes: 'Minutes to watch (1–60)', howManySubs: 'How many subscribers?', howManyCompletions: 'How many completions?', price: '≈ {{cost}} coins total ({{per}}/slot — earner gets {{reward}}{{extra}}). Final price confirmed by server.', extraMin: ' + 1/extra min', create: 'Create Campaign', creating: 'Creating…', mine: 'My campaigns', none: 'No campaigns yet — create one above!', done: 'done', pause: 'Pause', resume: 'Resume', cancel: 'Cancel', errSlots: 'Enter how many slots you want.', errVideo: 'Paste your YouTube video URL.', errChannel: 'Pick or add a channel to grow.', created: 'Campaign created! Spent {{coins}} coins.', createdFree: 'Campaign created (free — owner).', cancelConfirm: 'Cancel this campaign? Remaining slots are refunded.', channelLabel: 'Channel to grow', addChannel: 'Add channel', adding: 'Adding…', channelAdded: 'Channel added:', noChannelYet: 'No channel yet — add one below.' },
    status: { active: 'active', paused: 'paused', completed: 'completed', cancelled: 'cancelled' },
    wallet: { title: 'Wallet', none: 'No transactions yet.' },
    profile: { title: 'Profile', coins: 'Coins', role: 'Role', channel: 'Channel', linked: 'Linked', support: 'Support', language: 'Language', admin: 'Admin Panel', signOut: 'Sign Out', deleteAccount: 'Delete Account', deleteConfirm: 'Permanently delete your account and all data? This cannot be undone.' },
    tx: { welcome: '🎁 Welcome bonus', created: '📣 Campaign created — {{type}}, {{slots}} slots', free: ' (free)', completed: '✅ Task completed — {{type}}', completedComment: '✅ Task + comment bonus — {{type}}', refund: '↩️ Campaign refund', reclaimed: '⚠️ Coins reclaimed — {{type}}' },
  },

  ar: {
    common: { privacy: 'الخصوصية', terms: 'الشروط', done: 'تم', cancel: 'إلغاء', requestFailed: 'فشل الطلب', sessionExpired: 'انتهت الجلسة — سجّل الدخول مرة أخرى.' },
    login: { tagline: 'اكسب العملات بدعم المبدعين الآخرين.<br>أنفِقها لتنمية قناتك.', continue: 'المتابعة باستخدام Google', signingIn: 'جارٍ تسجيل الدخول…', disclaimer: 'نستخدم حساب Google للتحقّق من إجراءات YouTube.', cancelled: 'تم إلغاء تسجيل الدخول.', closed: 'تم إغلاق نافذة تسجيل الدخول.', loading: 'ما زال تسجيل الدخول عبر Google قيد التحميل — حاول بعد ثانية.' },
    tabs: { earn: 'اكسب', grow: 'نمِّ', wallet: 'المحفظة', profile: 'الملف الشخصي' },
    earn: { title: 'اكسب عملات', all: 'الكل', none: 'لا توجد مهام الآن.', checkBack: 'اسحب للأسفل أو عُد قريبًا!', left: 'متبقٍ', min: 'دقيقة' },
    task: { subscribe: 'اشتراك', like: 'إعجاب', like_comment: 'إعجاب + تعليق', subscribe_like: 'اشتراك + إعجاب', watch: 'مشاهدة' },
    steps: {
      subscribe: '1. افتح القناة على YouTube<br>2. اضغط <b>اشتراك</b><br>3. ارجع وتحقّق',
      like: '1. افتح الفيديو على YouTube<br>2. اضغط <b>👍 إعجاب</b><br>3. ارجع وتحقّق',
      like_comment: '1. افتح الفيديو<br>2. اضغط <b>👍 إعجاب</b> واترك <b>تعليقًا</b> (عملات إضافية!)<br>3. ارجع وتحقّق',
      subscribe_like: '1. افتح الفيديو<br>2. <b>اشترك</b> في القناة و<b>أعجب</b> بالفيديو<br>3. ارجع وتحقّق',
      watch: '1. افتح الفيديو<br>2. شاهد <b>{{min}} دقيقة على الأقل</b><br>3. ارجع وتحقّق',
    },
    modal: { open: '▶ افتح YouTube', verify: 'تحقّق واحصل', verifying: 'جارٍ التحقّق…', verifyIn: 'تحقّق ({{s}}ث)', openFirst: 'افتح YouTube أولًا — يبدأ المؤقّت عندها.', waitMore: 'انتظر {{s}} ثانية أخرى ثم تحقّق.', done: 'تم' },
    grow: { title: 'نمِّ', type: 'نوع الحملة', videoUrl: 'رابط الفيديو الخاص بك', minutes: 'دقائق المشاهدة (1–60)', howManySubs: 'كم عدد المشتركين؟', howManyCompletions: 'كم عدد الإنجازات؟', price: '≈ {{cost}} عملة إجمالًا ({{per}}/خانة — يحصل المنفّذ على {{reward}}{{extra}}). يؤكّد الخادم السعر النهائي.', extraMin: ' + 1/دقيقة إضافية', create: 'إنشاء حملة', creating: 'جارٍ الإنشاء…', mine: 'حملاتي', none: 'لا توجد حملات بعد — أنشئ واحدة بالأعلى!', done: 'منجز', pause: 'إيقاف مؤقّت', resume: 'استئناف', cancel: 'إلغاء', errSlots: 'أدخل عدد الخانات التي تريدها.', errVideo: 'الصق رابط فيديو YouTube.', errChannel: 'لا توجد قناة YouTube مرتبطة بحسابك. سجّل الخروج ثم الدخول لتسجيلها.', created: 'تم إنشاء الحملة! أُنفقت {{coins}} عملة.', createdFree: 'تم إنشاء الحملة (مجانًا — مالك).', cancelConfirm: 'إلغاء هذه الحملة؟ تُستردّ الخانات المتبقية.' },
    status: { active: 'نشطة', paused: 'متوقّفة', completed: 'مكتملة', cancelled: 'ملغاة' },
    wallet: { title: 'المحفظة', none: 'لا توجد معاملات بعد.' },
    profile: { title: 'الملف الشخصي', coins: 'العملات', role: 'الدور', channel: 'القناة', linked: 'مرتبطة', support: 'الدعم', language: 'اللغة', signOut: 'تسجيل الخروج', deleteAccount: 'حذف الحساب', deleteConfirm: 'حذف حسابك وكل بياناتك نهائيًا؟ لا يمكن التراجع.' },
    tx: { welcome: '🎁 مكافأة الترحيب', created: '📣 إنشاء حملة — {{type}}، {{slots}} خانة', free: ' (مجانًا)', completed: '✅ اكتملت مهمة — {{type}}', completedComment: '✅ مهمة + مكافأة تعليق — {{type}}', refund: '↩️ استرداد حملة', reclaimed: '⚠️ تم استرداد العملات — {{type}}' },
  },

  fr: {
    common: { privacy: 'Confidentialité', terms: 'Conditions', done: 'Terminé', cancel: 'Annuler', requestFailed: 'Échec de la requête', sessionExpired: 'Session expirée — reconnectez-vous.' },
    login: { tagline: 'Gagnez des pièces en soutenant d’autres créateurs.<br>Dépensez-les pour développer votre chaîne.', continue: 'Continuer avec Google', signingIn: 'Connexion…', disclaimer: 'Nous utilisons votre compte Google pour vérifier les actions YouTube.', cancelled: 'Connexion annulée.', closed: 'Connexion fermée.', loading: 'La connexion Google se charge encore — réessayez dans un instant.' },
    tabs: { earn: 'Gagner', grow: 'Booster', wallet: 'Portefeuille', profile: 'Profil' },
    earn: { title: 'Gagner des pièces', all: 'Tout', none: 'Aucune tâche pour le moment.', checkBack: 'Tirez vers le bas ou revenez bientôt !', left: 'restant', min: 'min' },
    task: { subscribe: 'S’abonner', like: 'J’aime', like_comment: 'J’aime + Commentaire', subscribe_like: 'Abo + J’aime', watch: 'Regarder' },
    steps: {
      subscribe: '1. Ouvrez la chaîne sur YouTube<br>2. Appuyez sur <b>S’abonner</b><br>3. Revenez et vérifiez',
      like: '1. Ouvrez la vidéo sur YouTube<br>2. Appuyez sur <b>👍 J’aime</b><br>3. Revenez et vérifiez',
      like_comment: '1. Ouvrez la vidéo<br>2. Appuyez sur <b>👍 J’aime</b> et laissez un <b>commentaire</b> (pièces bonus !)<br>3. Revenez et vérifiez',
      subscribe_like: '1. Ouvrez la vidéo<br>2. <b>Abonnez-vous</b> à la chaîne et <b>aimez</b> la vidéo<br>3. Revenez et vérifiez',
      watch: '1. Ouvrez la vidéo<br>2. Regardez au moins <b>{{min}} minute(s)</b><br>3. Revenez et vérifiez',
    },
    modal: { open: '▶ Ouvrir YouTube', verify: 'Vérifier et réclamer', verifying: 'Vérification…', verifyIn: 'Vérifier ({{s}}s)', openFirst: 'Ouvrez d’abord YouTube — le minuteur démarre alors.', waitMore: 'Attendez encore {{s}}s, puis vérifiez.', done: 'Terminé' },
    grow: { title: 'Booster', type: 'Type de campagne', videoUrl: 'URL de votre vidéo', minutes: 'Minutes à regarder (1–60)', howManySubs: 'Combien d’abonnés ?', howManyCompletions: 'Combien de réalisations ?', price: '≈ {{cost}} pièces au total ({{per}}/place — le participant reçoit {{reward}}{{extra}}). Prix final confirmé par le serveur.', extraMin: ' + 1/min supp.', create: 'Créer la campagne', creating: 'Création…', mine: 'Mes campagnes', none: 'Aucune campagne — créez-en une ci-dessus !', done: 'fait', pause: 'Pause', resume: 'Reprendre', cancel: 'Annuler', errSlots: 'Indiquez le nombre de places souhaité.', errVideo: 'Collez l’URL de votre vidéo YouTube.', errChannel: 'Aucune chaîne YouTube liée à votre compte. Déconnectez-vous puis reconnectez-vous pour l’enregistrer.', created: 'Campagne créée ! {{coins}} pièces dépensées.', createdFree: 'Campagne créée (gratuit — propriétaire).', cancelConfirm: 'Annuler cette campagne ? Les places restantes sont remboursées.' },
    status: { active: 'active', paused: 'en pause', completed: 'terminée', cancelled: 'annulée' },
    wallet: { title: 'Portefeuille', none: 'Aucune transaction pour le moment.' },
    profile: { title: 'Profil', coins: 'Pièces', role: 'Rôle', channel: 'Chaîne', linked: 'Liée', support: 'Support', language: 'Langue', signOut: 'Se déconnecter', deleteAccount: 'Supprimer le compte', deleteConfirm: 'Supprimer définitivement votre compte et toutes vos données ? Action irréversible.' },
    tx: { welcome: '🎁 Bonus de bienvenue', created: '📣 Campagne créée — {{type}}, {{slots}} places', free: ' (gratuit)', completed: '✅ Tâche terminée — {{type}}', completedComment: '✅ Tâche + bonus commentaire — {{type}}', refund: '↩️ Remboursement de campagne', reclaimed: '⚠️ Pièces reprises — {{type}}' },
  },

  es: {
    common: { privacy: 'Privacidad', terms: 'Términos', done: 'Listo', cancel: 'Cancelar', requestFailed: 'La solicitud falló', sessionExpired: 'Sesión expirada — vuelve a iniciar sesión.' },
    login: { tagline: 'Gana monedas apoyando a otros creadores.<br>Gástalas para hacer crecer tu canal.', continue: 'Continuar con Google', signingIn: 'Iniciando sesión…', disclaimer: 'Usamos tu cuenta de Google para verificar acciones de YouTube.', cancelled: 'Inicio de sesión cancelado.', closed: 'Se cerró el inicio de sesión.', loading: 'El inicio de sesión de Google aún se está cargando — inténtalo en un segundo.' },
    tabs: { earn: 'Ganar', grow: 'Crecer', wallet: 'Cartera', profile: 'Perfil' },
    earn: { title: 'Gana monedas', all: 'Todas', none: 'No hay tareas ahora mismo.', checkBack: 'Desliza hacia abajo o vuelve pronto.', left: 'rest.', min: 'min' },
    task: { subscribe: 'Suscribirse', like: 'Me gusta', like_comment: 'Me gusta + Comentario', subscribe_like: 'Sub + Me gusta', watch: 'Ver' },
    steps: {
      subscribe: '1. Abre el canal en YouTube<br>2. Pulsa <b>Suscribirse</b><br>3. Vuelve y verifica',
      like: '1. Abre el video en YouTube<br>2. Pulsa <b>👍 Me gusta</b><br>3. Vuelve y verifica',
      like_comment: '1. Abre el video<br>2. Pulsa <b>👍 Me gusta</b> y deja un <b>comentario</b> (¡monedas extra!)<br>3. Vuelve y verifica',
      subscribe_like: '1. Abre el video<br>2. <b>Suscríbete</b> al canal y dale <b>Me gusta</b> al video<br>3. Vuelve y verifica',
      watch: '1. Abre el video<br>2. Mira al menos <b>{{min}} minuto(s)</b><br>3. Vuelve y verifica',
    },
    modal: { open: '▶ Abrir YouTube', verify: 'Verificar y reclamar', verifying: 'Verificando…', verifyIn: 'Verificar ({{s}}s)', openFirst: 'Abre YouTube primero — el temporizador empieza entonces.', waitMore: 'Espera {{s}}s más y verifica.', done: 'Listo' },
    grow: { title: 'Crecer', type: 'Tipo de campaña', videoUrl: 'URL de tu video', minutes: 'Minutos a ver (1–60)', howManySubs: '¿Cuántos suscriptores?', howManyCompletions: '¿Cuántas realizaciones?', price: '≈ {{cost}} monedas en total ({{per}}/cupo — quien la hace recibe {{reward}}{{extra}}). Precio final confirmado por el servidor.', extraMin: ' + 1/min extra', create: 'Crear campaña', creating: 'Creando…', mine: 'Mis campañas', none: 'Aún no hay campañas — ¡crea una arriba!', done: 'hecho', pause: 'Pausar', resume: 'Reanudar', cancel: 'Cancelar', errSlots: 'Indica cuántos cupos quieres.', errVideo: 'Pega la URL de tu video de YouTube.', errChannel: 'No hay canal de YouTube vinculado a tu cuenta. Cierra sesión y vuelve a entrar para registrarlo.', created: '¡Campaña creada! Gastaste {{coins}} monedas.', createdFree: 'Campaña creada (gratis — propietario).', cancelConfirm: '¿Cancelar esta campaña? Los cupos restantes se reembolsan.' },
    status: { active: 'activa', paused: 'pausada', completed: 'completada', cancelled: 'cancelada' },
    wallet: { title: 'Cartera', none: 'Aún no hay transacciones.' },
    profile: { title: 'Perfil', coins: 'Monedas', role: 'Rol', channel: 'Canal', linked: 'Vinculado', support: 'Soporte', language: 'Idioma', signOut: 'Cerrar sesión', deleteAccount: 'Eliminar cuenta', deleteConfirm: '¿Eliminar permanentemente tu cuenta y todos los datos? No se puede deshacer.' },
    tx: { welcome: '🎁 Bono de bienvenida', created: '📣 Campaña creada — {{type}}, {{slots}} cupos', free: ' (gratis)', completed: '✅ Tarea completada — {{type}}', completedComment: '✅ Tarea + bono de comentario — {{type}}', refund: '↩️ Reembolso de campaña', reclaimed: '⚠️ Monedas recuperadas — {{type}}' },
  },

  pt: {
    common: { privacy: 'Privacidade', terms: 'Termos', done: 'Concluído', cancel: 'Cancelar', requestFailed: 'Falha na solicitação', sessionExpired: 'Sessão expirada — entre novamente.' },
    login: { tagline: 'Ganhe moedas apoiando outros criadores.<br>Gaste-as para crescer seu canal.', continue: 'Continuar com o Google', signingIn: 'Entrando…', disclaimer: 'Usamos sua conta Google para verificar ações do YouTube.', cancelled: 'Login cancelado.', closed: 'O login foi fechado.', loading: 'O login do Google ainda está carregando — tente de novo em um segundo.' },
    tabs: { earn: 'Ganhar', grow: 'Crescer', wallet: 'Carteira', profile: 'Perfil' },
    earn: { title: 'Ganhe moedas', all: 'Todas', none: 'Nenhuma tarefa no momento.', checkBack: 'Puxe para baixo ou volte em breve!', left: 'rest.', min: 'min' },
    task: { subscribe: 'Inscrever-se', like: 'Curtir', like_comment: 'Curtir + Comentar', subscribe_like: 'Inscr. + Curtir', watch: 'Assistir' },
    steps: {
      subscribe: '1. Abra o canal no YouTube<br>2. Toque em <b>Inscrever-se</b><br>3. Volte e verifique',
      like: '1. Abra o vídeo no YouTube<br>2. Toque em <b>👍 Curtir</b><br>3. Volte e verifique',
      like_comment: '1. Abra o vídeo<br>2. Toque em <b>👍 Curtir</b> e deixe um <b>comentário</b> (moedas bônus!)<br>3. Volte e verifique',
      subscribe_like: '1. Abra o vídeo<br>2. <b>Inscreva-se</b> no canal e <b>curta</b> o vídeo<br>3. Volte e verifique',
      watch: '1. Abra o vídeo<br>2. Assista pelo menos <b>{{min}} minuto(s)</b><br>3. Volte e verifique',
    },
    modal: { open: '▶ Abrir YouTube', verify: 'Verificar e resgatar', verifying: 'Verificando…', verifyIn: 'Verificar ({{s}}s)', openFirst: 'Abra o YouTube primeiro — o cronômetro começa então.', waitMore: 'Espere mais {{s}}s e verifique.', done: 'Concluído' },
    grow: { title: 'Crescer', type: 'Tipo de campanha', videoUrl: 'URL do seu vídeo', minutes: 'Minutos para assistir (1–60)', howManySubs: 'Quantos inscritos?', howManyCompletions: 'Quantas conclusões?', price: '≈ {{cost}} moedas no total ({{per}}/vaga — quem faz recebe {{reward}}{{extra}}). Preço final confirmado pelo servidor.', extraMin: ' + 1/min extra', create: 'Criar campanha', creating: 'Criando…', mine: 'Minhas campanhas', none: 'Nenhuma campanha ainda — crie uma acima!', done: 'feito', pause: 'Pausar', resume: 'Retomar', cancel: 'Cancelar', errSlots: 'Informe quantas vagas você quer.', errVideo: 'Cole a URL do seu vídeo do YouTube.', errChannel: 'Nenhum canal do YouTube vinculado à sua conta. Saia e entre novamente para registrá-lo.', created: 'Campanha criada! Gastou {{coins}} moedas.', createdFree: 'Campanha criada (grátis — proprietário).', cancelConfirm: 'Cancelar esta campanha? As vagas restantes são reembolsadas.' },
    status: { active: 'ativa', paused: 'pausada', completed: 'concluída', cancelled: 'cancelada' },
    wallet: { title: 'Carteira', none: 'Nenhuma transação ainda.' },
    profile: { title: 'Perfil', coins: 'Moedas', role: 'Função', channel: 'Canal', linked: 'Vinculado', support: 'Suporte', language: 'Idioma', signOut: 'Sair', deleteAccount: 'Excluir conta', deleteConfirm: 'Excluir permanentemente sua conta e todos os dados? Isto não pode ser desfeito.' },
    tx: { welcome: '🎁 Bônus de boas-vindas', created: '📣 Campanha criada — {{type}}, {{slots}} vagas', free: ' (grátis)', completed: '✅ Tarefa concluída — {{type}}', completedComment: '✅ Tarefa + bônus de comentário — {{type}}', refund: '↩️ Reembolso de campanha', reclaimed: '⚠️ Moedas retomadas — {{type}}' },
  },

  tr: {
    common: { privacy: 'Gizlilik', terms: 'Koşullar', done: 'Tamam', cancel: 'İptal', requestFailed: 'İstek başarısız', sessionExpired: 'Oturum süresi doldu — tekrar giriş yapın.' },
    login: { tagline: 'Diğer içerik üreticilerini destekleyerek coin kazanın.<br>Kanalınızı büyütmek için harcayın.', continue: 'Google ile devam et', signingIn: 'Giriş yapılıyor…', disclaimer: 'YouTube işlemlerini doğrulamak için Google hesabınızı kullanırız.', cancelled: 'Giriş iptal edildi.', closed: 'Giriş penceresi kapatıldı.', loading: 'Google girişi hâlâ yükleniyor — bir saniye sonra tekrar deneyin.' },
    tabs: { earn: 'Kazan', grow: 'Büyüt', wallet: 'Cüzdan', profile: 'Profil' },
    earn: { title: 'Coin Kazan', all: 'Tümü', none: 'Şu anda görev yok.', checkBack: 'Aşağı çekin veya yakında tekrar bakın!', left: 'kaldı', min: 'dk' },
    task: { subscribe: 'Abone ol', like: 'Beğen', like_comment: 'Beğen + Yorum', subscribe_like: 'Abone + Beğen', watch: 'İzle' },
    steps: {
      subscribe: '1. Kanalı YouTube’da aç<br>2. <b>Abone ol</b>’a dokun<br>3. Geri dön ve doğrula',
      like: '1. Videoyu YouTube’da aç<br>2. <b>👍 Beğen</b>’e dokun<br>3. Geri dön ve doğrula',
      like_comment: '1. Videoyu aç<br>2. <b>👍 Beğen</b>’e dokun ve bir <b>yorum</b> bırak (bonus coin!)<br>3. Geri dön ve doğrula',
      subscribe_like: '1. Videoyu aç<br>2. Kanala <b>abone ol</b> ve videoyu <b>beğen</b><br>3. Geri dön ve doğrula',
      watch: '1. Videoyu aç<br>2. En az <b>{{min}} dakika</b> izle<br>3. Geri dön ve doğrula',
    },
    modal: { open: '▶ YouTube’u aç', verify: 'Doğrula ve al', verifying: 'Doğrulanıyor…', verifyIn: 'Doğrula ({{s}}sn)', openFirst: 'Önce YouTube’u aç — sayaç o zaman başlar.', waitMore: '{{s}} saniye daha bekle, sonra doğrula.', done: 'Tamam' },
    grow: { title: 'Büyüt', type: 'Kampanya türü', videoUrl: 'Video URL’niz', minutes: 'İzleme dakikası (1–60)', howManySubs: 'Kaç abone?', howManyCompletions: 'Kaç tamamlama?', price: '≈ toplam {{cost}} coin ({{per}}/kontenjan — yapan {{reward}}{{extra}} alır). Son fiyatı sunucu onaylar.', extraMin: ' + ek dk başına 1', create: 'Kampanya oluştur', creating: 'Oluşturuluyor…', mine: 'Kampanyalarım', none: 'Henüz kampanya yok — yukarıdan bir tane oluşturun!', done: 'tamam', pause: 'Duraklat', resume: 'Devam et', cancel: 'İptal', errSlots: 'Kaç kontenjan istediğinizi girin.', errVideo: 'YouTube video URL’nizi yapıştırın.', errChannel: 'Hesabınıza bağlı YouTube kanalı yok. Kaydetmek için çıkıp tekrar giriş yapın.', created: 'Kampanya oluşturuldu! {{coins}} coin harcandı.', createdFree: 'Kampanya oluşturuldu (ücretsiz — sahip).', cancelConfirm: 'Bu kampanya iptal edilsin mi? Kalan kontenjanlar iade edilir.' },
    status: { active: 'aktif', paused: 'duraklatıldı', completed: 'tamamlandı', cancelled: 'iptal' },
    wallet: { title: 'Cüzdan', none: 'Henüz işlem yok.' },
    profile: { title: 'Profil', coins: 'Coin', role: 'Rol', channel: 'Kanal', linked: 'Bağlı', support: 'Destek', language: 'Dil', signOut: 'Çıkış yap', deleteAccount: 'Hesabı sil', deleteConfirm: 'Hesabınız ve tüm verileriniz kalıcı olarak silinsin mi? Bu geri alınamaz.' },
    tx: { welcome: '🎁 Hoş geldin bonusu', created: '📣 Kampanya oluşturuldu — {{type}}, {{slots}} kontenjan', free: ' (ücretsiz)', completed: '✅ Görev tamamlandı — {{type}}', completedComment: '✅ Görev + yorum bonusu — {{type}}', refund: '↩️ Kampanya iadesi', reclaimed: '⚠️ Coinler geri alındı — {{type}}' },
  },

  id: {
    common: { privacy: 'Privasi', terms: 'Ketentuan', done: 'Selesai', cancel: 'Batal', requestFailed: 'Permintaan gagal', sessionExpired: 'Sesi berakhir — masuk lagi.' },
    login: { tagline: 'Dapatkan koin dengan mendukung kreator lain.<br>Gunakan untuk menumbuhkan channel-mu.', continue: 'Lanjutkan dengan Google', signingIn: 'Masuk…', disclaimer: 'Kami memakai akun Google-mu untuk memverifikasi tindakan YouTube.', cancelled: 'Masuk dibatalkan.', closed: 'Jendela masuk ditutup.', loading: 'Masuk Google masih dimuat — coba lagi sebentar.' },
    tabs: { earn: 'Hasilkan', grow: 'Tumbuh', wallet: 'Dompet', profile: 'Profil' },
    earn: { title: 'Hasilkan Koin', all: 'Semua', none: 'Belum ada tugas saat ini.', checkBack: 'Tarik ke bawah atau cek lagi nanti!', left: 'tersisa', min: 'mnt' },
    task: { subscribe: 'Langganan', like: 'Suka', like_comment: 'Suka + Komentar', subscribe_like: 'Langg. + Suka', watch: 'Tonton' },
    steps: {
      subscribe: '1. Buka channel di YouTube<br>2. Ketuk <b>Subscribe</b><br>3. Kembali dan verifikasi',
      like: '1. Buka video di YouTube<br>2. Ketuk <b>👍 Suka</b><br>3. Kembali dan verifikasi',
      like_comment: '1. Buka video<br>2. Ketuk <b>👍 Suka</b> dan tinggalkan <b>komentar</b> (koin bonus!)<br>3. Kembali dan verifikasi',
      subscribe_like: '1. Buka video<br>2. <b>Subscribe</b> channel dan <b>Suka</b> videonya<br>3. Kembali dan verifikasi',
      watch: '1. Buka video<br>2. Tonton minimal <b>{{min}} menit</b><br>3. Kembali dan verifikasi',
    },
    modal: { open: '▶ Buka YouTube', verify: 'Verifikasi & Klaim', verifying: 'Memverifikasi…', verifyIn: 'Verifikasi ({{s}}d)', openFirst: 'Buka YouTube dulu — pewaktu mulai saat itu.', waitMore: 'Tunggu {{s}}d lagi, lalu verifikasi.', done: 'Selesai' },
    grow: { title: 'Tumbuh', type: 'Jenis kampanye', videoUrl: 'URL video kamu', minutes: 'Menit menonton (1–60)', howManySubs: 'Berapa subscriber?', howManyCompletions: 'Berapa penyelesaian?', price: '≈ total {{cost}} koin ({{per}}/slot — pelaku dapat {{reward}}{{extra}}). Harga akhir dikonfirmasi server.', extraMin: ' + 1/menit ekstra', create: 'Buat kampanye', creating: 'Membuat…', mine: 'Kampanye saya', none: 'Belum ada kampanye — buat satu di atas!', done: 'selesai', pause: 'Jeda', resume: 'Lanjut', cancel: 'Batal', errSlots: 'Masukkan berapa slot yang kamu mau.', errVideo: 'Tempel URL video YouTube kamu.', errChannel: 'Tidak ada channel YouTube yang tertaut ke akunmu. Keluar dan masuk lagi untuk mendaftarkannya.', created: 'Kampanye dibuat! Menghabiskan {{coins}} koin.', createdFree: 'Kampanye dibuat (gratis — pemilik).', cancelConfirm: 'Batalkan kampanye ini? Slot tersisa dikembalikan.' },
    status: { active: 'aktif', paused: 'dijeda', completed: 'selesai', cancelled: 'dibatalkan' },
    wallet: { title: 'Dompet', none: 'Belum ada transaksi.' },
    profile: { title: 'Profil', coins: 'Koin', role: 'Peran', channel: 'Channel', linked: 'Tertaut', support: 'Dukungan', language: 'Bahasa', signOut: 'Keluar', deleteAccount: 'Hapus akun', deleteConfirm: 'Hapus permanen akun dan semua datamu? Ini tidak bisa dibatalkan.' },
    tx: { welcome: '🎁 Bonus selamat datang', created: '📣 Kampanye dibuat — {{type}}, {{slots}} slot', free: ' (gratis)', completed: '✅ Tugas selesai — {{type}}', completedComment: '✅ Tugas + bonus komentar — {{type}}', refund: '↩️ Pengembalian kampanye', reclaimed: '⚠️ Koin ditarik kembali — {{type}}' },
  },

  hi: {
    common: { privacy: 'गोपनीयता', terms: 'शर्तें', done: 'हो गया', cancel: 'रद्द करें', requestFailed: 'अनुरोध विफल', sessionExpired: 'सत्र समाप्त — फिर से साइन इन करें।' },
    login: { tagline: 'दूसरे क्रिएटर्स का समर्थन करके सिक्के कमाएँ।<br>अपना चैनल बढ़ाने के लिए उन्हें खर्च करें।', continue: 'Google से जारी रखें', signingIn: 'साइन इन हो रहा है…', disclaimer: 'हम YouTube क्रियाओं की पुष्टि के लिए आपके Google खाते का उपयोग करते हैं।', cancelled: 'साइन इन रद्द किया गया।', closed: 'साइन इन बंद कर दिया गया।', loading: 'Google साइन इन अभी लोड हो रहा है — एक सेकंड में फिर कोशिश करें।' },
    tabs: { earn: 'कमाएँ', grow: 'बढ़ाएँ', wallet: 'वॉलेट', profile: 'प्रोफ़ाइल' },
    earn: { title: 'सिक्के कमाएँ', all: 'सभी', none: 'अभी कोई कार्य नहीं।', checkBack: 'नीचे खींचें या जल्द फिर देखें!', left: 'शेष', min: 'मिनट' },
    task: { subscribe: 'सब्सक्राइब', like: 'लाइक', like_comment: 'लाइक + कमेंट', subscribe_like: 'सब + लाइक', watch: 'देखें' },
    steps: {
      subscribe: '1. YouTube पर चैनल खोलें<br>2. <b>Subscribe</b> दबाएँ<br>3. वापस आकर सत्यापित करें',
      like: '1. YouTube पर वीडियो खोलें<br>2. <b>👍 Like</b> दबाएँ<br>3. वापस आकर सत्यापित करें',
      like_comment: '1. वीडियो खोलें<br>2. <b>👍 Like</b> दबाएँ और एक <b>कमेंट</b> करें (बोनस सिक्के!)<br>3. वापस आकर सत्यापित करें',
      subscribe_like: '1. वीडियो खोलें<br>2. चैनल को <b>सब्सक्राइब</b> करें और वीडियो को <b>लाइक</b> करें<br>3. वापस आकर सत्यापित करें',
      watch: '1. वीडियो खोलें<br>2. कम से कम <b>{{min}} मिनट</b> देखें<br>3. वापस आकर सत्यापित करें',
    },
    modal: { open: '▶ YouTube खोलें', verify: 'सत्यापित करें और लें', verifying: 'सत्यापित हो रहा है…', verifyIn: 'सत्यापित ({{s}}से)', openFirst: 'पहले YouTube खोलें — टाइमर तभी शुरू होता है।', waitMore: '{{s}} सेकंड और रुकें, फिर सत्यापित करें।', done: 'हो गया' },
    grow: { title: 'बढ़ाएँ', type: 'अभियान प्रकार', videoUrl: 'आपके वीडियो का URL', minutes: 'देखने के मिनट (1–60)', howManySubs: 'कितने सब्सक्राइबर?', howManyCompletions: 'कितने पूर्ण?', price: '≈ कुल {{cost}} सिक्के ({{per}}/स्लॉट — करने वाले को {{reward}}{{extra}} मिलते हैं)। अंतिम मूल्य सर्वर तय करता है।', extraMin: ' + 1/अतिरिक्त मिनट', create: 'अभियान बनाएँ', creating: 'बना रहे हैं…', mine: 'मेरे अभियान', none: 'अभी कोई अभियान नहीं — ऊपर एक बनाएँ!', done: 'पूर्ण', pause: 'रोकें', resume: 'फिर शुरू', cancel: 'रद्द करें', errSlots: 'आप कितने स्लॉट चाहते हैं दर्ज करें।', errVideo: 'अपने YouTube वीडियो का URL पेस्ट करें।', errChannel: 'आपके खाते से कोई YouTube चैनल जुड़ा नहीं है। इसे पंजीकृत करने के लिए साइन आउट करके फिर साइन इन करें।', created: 'अभियान बना! {{coins}} सिक्के खर्च हुए।', createdFree: 'अभियान बना (मुफ़्त — मालिक)।', cancelConfirm: 'यह अभियान रद्द करें? शेष स्लॉट वापस कर दिए जाते हैं।' },
    status: { active: 'सक्रिय', paused: 'रुका', completed: 'पूर्ण', cancelled: 'रद्द' },
    wallet: { title: 'वॉलेट', none: 'अभी कोई लेन-देन नहीं।' },
    profile: { title: 'प्रोफ़ाइल', coins: 'सिक्के', role: 'भूमिका', channel: 'चैनल', linked: 'जुड़ा', support: 'सहायता', language: 'भाषा', signOut: 'साइन आउट', deleteAccount: 'खाता हटाएँ', deleteConfirm: 'अपना खाता और सभी डेटा स्थायी रूप से हटाएँ? यह पूर्ववत नहीं हो सकता।' },
    tx: { welcome: '🎁 स्वागत बोनस', created: '📣 अभियान बना — {{type}}, {{slots}} स्लॉट', free: ' (मुफ़्त)', completed: '✅ कार्य पूर्ण — {{type}}', completedComment: '✅ कार्य + कमेंट बोनस — {{type}}', refund: '↩️ अभियान वापसी', reclaimed: '⚠️ सिक्के वापस लिए — {{type}}' },
  },

  ru: {
    common: { privacy: 'Конфиденциальность', terms: 'Условия', done: 'Готово', cancel: 'Отмена', requestFailed: 'Ошибка запроса', sessionExpired: 'Сессия истекла — войдите снова.' },
    login: { tagline: 'Зарабатывайте монеты, поддерживая других авторов.<br>Тратьте их на рост своего канала.', continue: 'Продолжить с Google', signingIn: 'Вход…', disclaimer: 'Мы используем ваш аккаунт Google для проверки действий на YouTube.', cancelled: 'Вход отменён.', closed: 'Окно входа закрыто.', loading: 'Вход через Google ещё загружается — попробуйте через секунду.' },
    tabs: { earn: 'Заработок', grow: 'Рост', wallet: 'Кошелёк', profile: 'Профиль' },
    earn: { title: 'Зарабатывай монеты', all: 'Все', none: 'Сейчас нет заданий.', checkBack: 'Потяните вниз или зайдите позже!', left: 'осталось', min: 'мин' },
    task: { subscribe: 'Подписаться', like: 'Лайк', like_comment: 'Лайк + Коммент', subscribe_like: 'Подп. + Лайк', watch: 'Смотреть' },
    steps: {
      subscribe: '1. Откройте канал на YouTube<br>2. Нажмите <b>Подписаться</b><br>3. Вернитесь и подтвердите',
      like: '1. Откройте видео на YouTube<br>2. Нажмите <b>👍 Лайк</b><br>3. Вернитесь и подтвердите',
      like_comment: '1. Откройте видео<br>2. Нажмите <b>👍 Лайк</b> и оставьте <b>комментарий</b> (бонусные монеты!)<br>3. Вернитесь и подтвердите',
      subscribe_like: '1. Откройте видео<br>2. <b>Подпишитесь</b> на канал и поставьте <b>лайк</b> видео<br>3. Вернитесь и подтвердите',
      watch: '1. Откройте видео<br>2. Смотрите не менее <b>{{min}} мин.</b><br>3. Вернитесь и подтвердите',
    },
    modal: { open: '▶ Открыть YouTube', verify: 'Проверить и получить', verifying: 'Проверка…', verifyIn: 'Проверить ({{s}}с)', openFirst: 'Сначала откройте YouTube — тогда запустится таймер.', waitMore: 'Подождите ещё {{s}}с, затем подтвердите.', done: 'Готово' },
    grow: { title: 'Рост', type: 'Тип кампании', videoUrl: 'URL вашего видео', minutes: 'Минут просмотра (1–60)', howManySubs: 'Сколько подписчиков?', howManyCompletions: 'Сколько выполнений?', price: '≈ {{cost}} монет всего ({{per}}/слот — исполнитель получает {{reward}}{{extra}}). Итоговую цену подтверждает сервер.', extraMin: ' + 1/доп. мин', create: 'Создать кампанию', creating: 'Создание…', mine: 'Мои кампании', none: 'Кампаний пока нет — создайте выше!', done: 'готово', pause: 'Пауза', resume: 'Возобновить', cancel: 'Отмена', errSlots: 'Укажите, сколько слотов вы хотите.', errVideo: 'Вставьте URL вашего видео на YouTube.', errChannel: 'К аккаунту не привязан канал YouTube. Выйдите и войдите снова, чтобы зарегистрировать его.', created: 'Кампания создана! Потрачено {{coins}} монет.', createdFree: 'Кампания создана (бесплатно — владелец).', cancelConfirm: 'Отменить эту кампанию? Оставшиеся слоты возвращаются.' },
    status: { active: 'активна', paused: 'пауза', completed: 'завершена', cancelled: 'отменена' },
    wallet: { title: 'Кошелёк', none: 'Транзакций пока нет.' },
    profile: { title: 'Профиль', coins: 'Монеты', role: 'Роль', channel: 'Канал', linked: 'Привязан', support: 'Поддержка', language: 'Язык', signOut: 'Выйти', deleteAccount: 'Удалить аккаунт', deleteConfirm: 'Навсегда удалить аккаунт и все данные? Это нельзя отменить.' },
    tx: { welcome: '🎁 Приветственный бонус', created: '📣 Кампания создана — {{type}}, {{slots}} слотов', free: ' (бесплатно)', completed: '✅ Задание выполнено — {{type}}', completedComment: '✅ Задание + бонус за комментарий — {{type}}', refund: '↩️ Возврат за кампанию', reclaimed: '⚠️ Монеты возвращены — {{type}}' },
  },

  de: {
    common: { privacy: 'Datenschutz', terms: 'Nutzungsbedingungen', done: 'Fertig', cancel: 'Abbrechen', requestFailed: 'Anfrage fehlgeschlagen', sessionExpired: 'Sitzung abgelaufen — bitte erneut anmelden.' },
    login: { tagline: 'Verdiene Münzen, indem du andere Creator unterstützt.<br>Gib sie aus, um deinen Kanal zu vergrößern.', continue: 'Mit Google fortfahren', signingIn: 'Anmeldung…', disclaimer: 'Wir nutzen dein Google-Konto, um YouTube-Aktionen zu verifizieren.', cancelled: 'Anmeldung abgebrochen.', closed: 'Anmeldefenster geschlossen.', loading: 'Die Google-Anmeldung lädt noch — versuch es gleich nochmal.' },
    tabs: { earn: 'Verdienen', grow: 'Wachsen', wallet: 'Wallet', profile: 'Profil' },
    earn: { title: 'Münzen verdienen', all: 'Alle', none: 'Gerade keine Aufgaben.', checkBack: 'Nach unten ziehen oder bald wieder vorbeischauen!', left: 'übrig', min: 'Min' },
    task: { subscribe: 'Abonnieren', like: 'Like', like_comment: 'Like + Kommentar', subscribe_like: 'Abo + Like', watch: 'Ansehen' },
    steps: {
      subscribe: '1. Kanal auf YouTube öffnen<br>2. Auf <b>Abonnieren</b> tippen<br>3. Zurückkommen und verifizieren',
      like: '1. Video auf YouTube öffnen<br>2. Auf <b>👍 Like</b> tippen<br>3. Zurückkommen und verifizieren',
      like_comment: '1. Video öffnen<br>2. Auf <b>👍 Like</b> tippen und einen <b>Kommentar</b> hinterlassen (Bonus-Münzen!)<br>3. Zurückkommen und verifizieren',
      subscribe_like: '1. Video öffnen<br>2. Kanal <b>abonnieren</b> und Video <b>liken</b><br>3. Zurückkommen und verifizieren',
      watch: '1. Video öffnen<br>2. Mindestens <b>{{min}} Minute(n)</b> ansehen<br>3. Zurückkommen und verifizieren',
    },
    modal: { open: '▶ YouTube öffnen', verify: 'Verifizieren & einlösen', verifying: 'Verifiziere…', verifyIn: 'Verifizieren ({{s}}s)', openFirst: 'Öffne zuerst YouTube — dann startet der Timer.', waitMore: 'Warte noch {{s}}s, dann verifizieren.', done: 'Fertig' },
    grow: { title: 'Wachsen', type: 'Kampagnentyp', videoUrl: 'Deine Video-URL', minutes: 'Minuten ansehen (1–60)', howManySubs: 'Wie viele Abonnenten?', howManyCompletions: 'Wie viele Abschlüsse?', price: '≈ {{cost}} Münzen gesamt ({{per}}/Platz — Ausführende erhalten {{reward}}{{extra}}). Endpreis bestätigt der Server.', extraMin: ' + 1/Extra-Min', create: 'Kampagne erstellen', creating: 'Erstelle…', mine: 'Meine Kampagnen', none: 'Noch keine Kampagnen — erstelle oben eine!', done: 'fertig', pause: 'Pause', resume: 'Fortsetzen', cancel: 'Abbrechen', errSlots: 'Gib an, wie viele Plätze du möchtest.', errVideo: 'Füge deine YouTube-Video-URL ein.', errChannel: 'Kein YouTube-Kanal mit deinem Konto verknüpft. Melde dich ab und wieder an, um ihn zu registrieren.', created: 'Kampagne erstellt! {{coins}} Münzen ausgegeben.', createdFree: 'Kampagne erstellt (kostenlos — Inhaber).', cancelConfirm: 'Diese Kampagne abbrechen? Übrige Plätze werden erstattet.' },
    status: { active: 'aktiv', paused: 'pausiert', completed: 'abgeschlossen', cancelled: 'abgebrochen' },
    wallet: { title: 'Wallet', none: 'Noch keine Transaktionen.' },
    profile: { title: 'Profil', coins: 'Münzen', role: 'Rolle', channel: 'Kanal', linked: 'Verknüpft', support: 'Support', language: 'Sprache', signOut: 'Abmelden', deleteAccount: 'Konto löschen', deleteConfirm: 'Konto und alle Daten dauerhaft löschen? Das kann nicht rückgängig gemacht werden.' },
    tx: { welcome: '🎁 Willkommensbonus', created: '📣 Kampagne erstellt — {{type}}, {{slots}} Plätze', free: ' (kostenlos)', completed: '✅ Aufgabe erledigt — {{type}}', completedComment: '✅ Aufgabe + Kommentar-Bonus — {{type}}', refund: '↩️ Kampagnen-Erstattung', reclaimed: '⚠️ Münzen zurückgefordert — {{type}}' },
  },

  'zh-CN': {
    common: { privacy: '隐私', terms: '条款', done: '完成', cancel: '取消', requestFailed: '请求失败', sessionExpired: '会话已过期 — 请重新登录。' },
    login: { tagline: '通过支持其他创作者赚取金币。<br>用它们发展你的频道。', continue: '使用 Google 继续', signingIn: '正在登录…', disclaimer: '我们使用你的 Google 账号来验证 YouTube 操作。', cancelled: '登录已取消。', closed: '登录窗口已关闭。', loading: 'Google 登录仍在加载 — 请稍后再试。' },
    tabs: { earn: '赚取', grow: '增长', wallet: '钱包', profile: '我的' },
    earn: { title: '赚取金币', all: '全部', none: '暂时没有任务。', checkBack: '下拉或稍后再来看看！', left: '剩余', min: '分钟' },
    task: { subscribe: '订阅', like: '点赞', like_comment: '点赞 + 评论', subscribe_like: '订阅 + 点赞', watch: '观看' },
    steps: {
      subscribe: '1. 在 YouTube 打开频道<br>2. 点击<b>订阅</b><br>3. 返回并验证',
      like: '1. 在 YouTube 打开视频<br>2. 点击 <b>👍 点赞</b><br>3. 返回并验证',
      like_comment: '1. 打开视频<br>2. 点击 <b>👍 点赞</b> 并留下<b>评论</b>（额外金币！）<br>3. 返回并验证',
      subscribe_like: '1. 打开视频<br>2. <b>订阅</b>频道并<b>点赞</b>视频<br>3. 返回并验证',
      watch: '1. 打开视频<br>2. 至少观看 <b>{{min}} 分钟</b><br>3. 返回并验证',
    },
    modal: { open: '▶ 打开 YouTube', verify: '验证并领取', verifying: '验证中…', verifyIn: '验证（{{s}}秒）', openFirst: '请先打开 YouTube — 计时器随后开始。', waitMore: '再等 {{s}} 秒后再验证。', done: '完成' },
    grow: { title: '增长', type: '活动类型', videoUrl: '你的视频网址', minutes: '观看分钟数（1–60）', howManySubs: '需要多少订阅者？', howManyCompletions: '需要多少完成数？', price: '≈ 共 {{cost}} 金币（{{per}}/名额 — 执行者获得 {{reward}}{{extra}}）。最终价格由服务器确认。', extraMin: ' + 每多 1 分钟加 1', create: '创建活动', creating: '创建中…', mine: '我的活动', none: '还没有活动 — 在上面创建一个吧！', done: '完成', pause: '暂停', resume: '继续', cancel: '取消', errSlots: '请输入你想要的名额数。', errVideo: '请粘贴你的 YouTube 视频网址。', errChannel: '你的账号未关联 YouTube 频道。请退出后重新登录以注册它。', created: '活动已创建！花费 {{coins}} 金币。', createdFree: '活动已创建（免费 — 拥有者）。', cancelConfirm: '取消此活动？剩余名额将退还。' },
    status: { active: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消' },
    wallet: { title: '钱包', none: '暂无交易。' },
    profile: { title: '我的', coins: '金币', role: '角色', channel: '频道', linked: '已关联', support: '支持', language: '语言', signOut: '退出登录', deleteAccount: '删除账号', deleteConfirm: '永久删除你的账号和所有数据？此操作无法撤销。' },
    tx: { welcome: '🎁 欢迎奖励', created: '📣 活动已创建 — {{type}}，{{slots}} 个名额', free: '（免费）', completed: '✅ 任务完成 — {{type}}', completedComment: '✅ 任务 + 评论奖励 — {{type}}', refund: '↩️ 活动退款', reclaimed: '⚠️ 金币已收回 — {{type}}' },
  },

  'zh-TW': {
    common: { privacy: '隱私', terms: '條款', done: '完成', cancel: '取消', requestFailed: '請求失敗', sessionExpired: '工作階段已過期 — 請重新登入。' },
    login: { tagline: '透過支持其他創作者賺取金幣。<br>用它們發展你的頻道。', continue: '使用 Google 繼續', signingIn: '登入中…', disclaimer: '我們使用你的 Google 帳戶來驗證 YouTube 操作。', cancelled: '登入已取消。', closed: '登入視窗已關閉。', loading: 'Google 登入仍在載入 — 請稍後再試。' },
    tabs: { earn: '賺取', grow: '成長', wallet: '錢包', profile: '個人' },
    earn: { title: '賺取金幣', all: '全部', none: '目前沒有任務。', checkBack: '下拉或稍後再來看看！', left: '剩餘', min: '分鐘' },
    task: { subscribe: '訂閱', like: '按讚', like_comment: '按讚 + 留言', subscribe_like: '訂閱 + 讚', watch: '觀看' },
    steps: {
      subscribe: '1. 在 YouTube 開啟頻道<br>2. 點擊<b>訂閱</b><br>3. 返回並驗證',
      like: '1. 在 YouTube 開啟影片<br>2. 點擊 <b>👍 讚</b><br>3. 返回並驗證',
      like_comment: '1. 開啟影片<br>2. 點擊 <b>👍 讚</b> 並留下<b>留言</b>（額外金幣！）<br>3. 返回並驗證',
      subscribe_like: '1. 開啟影片<br>2. <b>訂閱</b>頻道並<b>按讚</b>影片<br>3. 返回並驗證',
      watch: '1. 開啟影片<br>2. 至少觀看 <b>{{min}} 分鐘</b><br>3. 返回並驗證',
    },
    modal: { open: '▶ 開啟 YouTube', verify: '驗證並領取', verifying: '驗證中…', verifyIn: '驗證（{{s}}秒）', openFirst: '請先開啟 YouTube — 計時器隨後開始。', waitMore: '再等 {{s}} 秒後再驗證。', done: '完成' },
    grow: { title: '成長', type: '活動類型', videoUrl: '你的影片網址', minutes: '觀看分鐘數（1–60）', howManySubs: '需要多少訂閱者？', howManyCompletions: '需要多少完成數？', price: '≈ 共 {{cost}} 金幣（{{per}}/名額 — 執行者獲得 {{reward}}{{extra}}）。最終價格由伺服器確認。', extraMin: ' + 每多 1 分鐘加 1', create: '建立活動', creating: '建立中…', mine: '我的活動', none: '還沒有活動 — 在上面建立一個吧！', done: '完成', pause: '暫停', resume: '繼續', cancel: '取消', errSlots: '請輸入你想要的名額數。', errVideo: '請貼上你的 YouTube 影片網址。', errChannel: '你的帳戶未連結 YouTube 頻道。請登出後重新登入以註冊它。', created: '活動已建立！花費 {{coins}} 金幣。', createdFree: '活動已建立（免費 — 擁有者）。', cancelConfirm: '取消此活動？剩餘名額將退還。' },
    status: { active: '進行中', paused: '已暫停', completed: '已完成', cancelled: '已取消' },
    wallet: { title: '錢包', none: '尚無交易。' },
    profile: { title: '個人', coins: '金幣', role: '角色', channel: '頻道', linked: '已連結', support: '支援', language: '語言', signOut: '登出', deleteAccount: '刪除帳戶', deleteConfirm: '永久刪除你的帳戶和所有資料？此操作無法復原。' },
    tx: { welcome: '🎁 歡迎獎勵', created: '📣 活動已建立 — {{type}}，{{slots}} 個名額', free: '（免費）', completed: '✅ 任務完成 — {{type}}', completedComment: '✅ 任務 + 留言獎勵 — {{type}}', refund: '↩️ 活動退款', reclaimed: '⚠️ 金幣已收回 — {{type}}' },
  },

  bn: {
    common: { privacy: 'গোপনীয়তা', terms: 'শর্তাবলী', done: 'সম্পন্ন', cancel: 'বাতিল', requestFailed: 'অনুরোধ ব্যর্থ', sessionExpired: 'সেশন শেষ — আবার সাইন ইন করুন।' },
    login: { tagline: 'অন্য নির্মাতাদের সমর্থন করে কয়েন আয় করুন।<br>আপনার চ্যানেল বাড়াতে সেগুলো খরচ করুন।', continue: 'Google দিয়ে চালিয়ে যান', signingIn: 'সাইন ইন হচ্ছে…', disclaimer: 'YouTube ক্রিয়া যাচাই করতে আমরা আপনার Google অ্যাকাউন্ট ব্যবহার করি।', cancelled: 'সাইন ইন বাতিল হয়েছে।', closed: 'সাইন ইন উইন্ডো বন্ধ হয়েছে।', loading: 'Google সাইন ইন এখনও লোড হচ্ছে — এক সেকেন্ড পরে আবার চেষ্টা করুন।' },
    tabs: { earn: 'আয়', grow: 'বৃদ্ধি', wallet: 'ওয়ালেট', profile: 'প্রোফাইল' },
    earn: { title: 'কয়েন আয় করুন', all: 'সব', none: 'এখন কোনো কাজ নেই।', checkBack: 'নিচে টানুন বা শীঘ্রই আবার দেখুন!', left: 'বাকি', min: 'মিনিট' },
    task: { subscribe: 'সাবস্ক্রাইব', like: 'লাইক', like_comment: 'লাইক + কমেন্ট', subscribe_like: 'সাব + লাইক', watch: 'দেখুন' },
    steps: {
      subscribe: '1. YouTube-এ চ্যানেল খুলুন<br>2. <b>Subscribe</b> চাপুন<br>3. ফিরে এসে যাচাই করুন',
      like: '1. YouTube-এ ভিডিও খুলুন<br>2. <b>👍 Like</b> চাপুন<br>3. ফিরে এসে যাচাই করুন',
      like_comment: '1. ভিডিও খুলুন<br>2. <b>👍 Like</b> চাপুন এবং একটি <b>কমেন্ট</b> দিন (বোনাস কয়েন!)<br>3. ফিরে এসে যাচাই করুন',
      subscribe_like: '1. ভিডিও খুলুন<br>2. চ্যানেল <b>সাবস্ক্রাইব</b> করুন এবং ভিডিও <b>লাইক</b> করুন<br>3. ফিরে এসে যাচাই করুন',
      watch: '1. ভিডিও খুলুন<br>2. অন্তত <b>{{min}} মিনিট</b> দেখুন<br>3. ফিরে এসে যাচাই করুন',
    },
    modal: { open: '▶ YouTube খুলুন', verify: 'যাচাই করে নিন', verifying: 'যাচাই হচ্ছে…', verifyIn: 'যাচাই ({{s}}সে)', openFirst: 'আগে YouTube খুলুন — তখনই টাইমার শুরু হয়।', waitMore: 'আরও {{s}} সেকেন্ড অপেক্ষা করে যাচাই করুন।', done: 'সম্পন্ন' },
    grow: { title: 'বৃদ্ধি', type: 'ক্যাম্পেইন ধরন', videoUrl: 'আপনার ভিডিও URL', minutes: 'দেখার মিনিট (1–60)', howManySubs: 'কতজন সাবস্ক্রাইবার?', howManyCompletions: 'কতগুলো সম্পন্ন?', price: '≈ মোট {{cost}} কয়েন ({{per}}/স্লট — যিনি করেন তিনি {{reward}}{{extra}} পান)। চূড়ান্ত দাম সার্ভার নিশ্চিত করে।', extraMin: ' + প্রতি অতিরিক্ত মিনিটে 1', create: 'ক্যাম্পেইন তৈরি করুন', creating: 'তৈরি হচ্ছে…', mine: 'আমার ক্যাম্পেইন', none: 'এখনও কোনো ক্যাম্পেইন নেই — উপরে একটি তৈরি করুন!', done: 'সম্পন্ন', pause: 'বিরতি', resume: 'আবার শুরু', cancel: 'বাতিল', errSlots: 'আপনি কতগুলো স্লট চান লিখুন।', errVideo: 'আপনার YouTube ভিডিও URL পেস্ট করুন।', errChannel: 'আপনার অ্যাকাউন্টে কোনো YouTube চ্যানেল যুক্ত নেই। নিবন্ধন করতে সাইন আউট করে আবার সাইন ইন করুন।', created: 'ক্যাম্পেইন তৈরি হয়েছে! {{coins}} কয়েন খরচ হয়েছে।', createdFree: 'ক্যাম্পেইন তৈরি হয়েছে (ফ্রি — মালিক)।', cancelConfirm: 'এই ক্যাম্পেইন বাতিল করবেন? বাকি স্লট ফেরত দেওয়া হবে।' },
    status: { active: 'সক্রিয়', paused: 'বিরতি', completed: 'সম্পন্ন', cancelled: 'বাতিল' },
    wallet: { title: 'ওয়ালেট', none: 'এখনও কোনো লেনদেন নেই।' },
    profile: { title: 'প্রোফাইল', coins: 'কয়েন', role: 'ভূমিকা', channel: 'চ্যানেল', linked: 'যুক্ত', support: 'সহায়তা', language: 'ভাষা', signOut: 'সাইন আউট', deleteAccount: 'অ্যাকাউন্ট মুছুন', deleteConfirm: 'স্থায়ীভাবে আপনার অ্যাকাউন্ট ও সব ডেটা মুছবেন? এটি ফেরানো যাবে না।' },
    tx: { welcome: '🎁 স্বাগত বোনাস', created: '📣 ক্যাম্পেইন তৈরি — {{type}}, {{slots}} স্লট', free: ' (ফ্রি)', completed: '✅ কাজ সম্পন্ন — {{type}}', completedComment: '✅ কাজ + কমেন্ট বোনাস — {{type}}', refund: '↩️ ক্যাম্পেইন ফেরত', reclaimed: '⚠️ কয়েন ফেরত নেওয়া হয়েছে — {{type}}' },
  },

  ja: {
    common: { privacy: 'プライバシー', terms: '規約', done: '完了', cancel: 'キャンセル', requestFailed: 'リクエストに失敗しました', sessionExpired: 'セッションが切れました — 再度サインインしてください。' },
    login: { tagline: '他のクリエイターを応援してコインを獲得。<br>使って自分のチャンネルを伸ばそう。', continue: 'Google で続行', signingIn: 'サインイン中…', disclaimer: 'YouTube の操作を確認するために Google アカウントを使用します。', cancelled: 'サインインをキャンセルしました。', closed: 'サインイン画面を閉じました。', loading: 'Google サインインを読み込み中です — 少し待って再試行してください。' },
    tabs: { earn: '稼ぐ', grow: '成長', wallet: 'ウォレット', profile: 'プロフィール' },
    earn: { title: 'コインを稼ぐ', all: 'すべて', none: '今はタスクがありません。', checkBack: '下に引くか、後でまた確認してね！', left: '残り', min: '分' },
    task: { subscribe: '登録', like: '高評価', like_comment: '高評価＋コメント', subscribe_like: '登録＋高評価', watch: '視聴' },
    steps: {
      subscribe: '1. YouTube でチャンネルを開く<br>2. <b>登録</b>をタップ<br>3. 戻って確認',
      like: '1. YouTube で動画を開く<br>2. <b>👍 高評価</b>をタップ<br>3. 戻って確認',
      like_comment: '1. 動画を開く<br>2. <b>👍 高評価</b>をタップして<b>コメント</b>を残す（ボーナスコイン！）<br>3. 戻って確認',
      subscribe_like: '1. 動画を開く<br>2. チャンネルを<b>登録</b>して動画に<b>高評価</b><br>3. 戻って確認',
      watch: '1. 動画を開く<br>2. 少なくとも <b>{{min}} 分</b>視聴<br>3. 戻って確認',
    },
    modal: { open: '▶ YouTube を開く', verify: '確認して受け取る', verifying: '確認中…', verifyIn: '確認（{{s}}秒）', openFirst: '先に YouTube を開いてください — タイマーはそのとき開始します。', waitMore: 'あと {{s}} 秒待ってから確認してください。', done: '完了' },
    grow: { title: '成長', type: 'キャンペーンの種類', videoUrl: 'あなたの動画URL', minutes: '視聴する分数（1–60）', howManySubs: '登録者は何人？', howManyCompletions: '完了数はいくつ？', price: '≈ 合計 {{cost}} コイン（{{per}}/枠 — 実行者は {{reward}}{{extra}} を獲得）。最終価格はサーバーが確定します。', extraMin: ' + 追加1分ごとに1', create: 'キャンペーンを作成', creating: '作成中…', mine: 'マイキャンペーン', none: 'まだキャンペーンがありません — 上で作成しましょう！', done: '完了', pause: '一時停止', resume: '再開', cancel: 'キャンセル', errSlots: '希望する枠数を入力してください。', errVideo: 'YouTube の動画URLを貼り付けてください。', errChannel: 'アカウントに YouTube チャンネルが連携されていません。サインアウトして再度サインインし登録してください。', created: 'キャンペーンを作成しました！{{coins}} コイン使用。', createdFree: 'キャンペーンを作成しました（無料 — オーナー）。', cancelConfirm: 'このキャンペーンをキャンセルしますか？残り枠は返金されます。' },
    status: { active: '実行中', paused: '一時停止', completed: '完了', cancelled: 'キャンセル' },
    wallet: { title: 'ウォレット', none: 'まだ取引がありません。' },
    profile: { title: 'プロフィール', coins: 'コイン', role: '役割', channel: 'チャンネル', linked: '連携済み', support: 'サポート', language: '言語', signOut: 'サインアウト', deleteAccount: 'アカウント削除', deleteConfirm: 'アカウントと全データを完全に削除しますか？元に戻せません。' },
    tx: { welcome: '🎁 ウェルカムボーナス', created: '📣 キャンペーン作成 — {{type}}、{{slots}} 枠', free: '（無料）', completed: '✅ タスク完了 — {{type}}', completedComment: '✅ タスク＋コメントボーナス — {{type}}', refund: '↩️ キャンペーン返金', reclaimed: '⚠️ コイン回収 — {{type}}' },
  },

  ko: {
    common: { privacy: '개인정보', terms: '약관', done: '완료', cancel: '취소', requestFailed: '요청 실패', sessionExpired: '세션이 만료되었습니다 — 다시 로그인하세요.' },
    login: { tagline: '다른 크리에이터를 응원하고 코인을 받으세요.<br>코인으로 내 채널을 키우세요.', continue: 'Google로 계속하기', signingIn: '로그인 중…', disclaimer: 'YouTube 활동을 확인하기 위해 Google 계정을 사용합니다.', cancelled: '로그인이 취소되었습니다.', closed: '로그인 창이 닫혔습니다.', loading: 'Google 로그인이 아직 로딩 중입니다 — 잠시 후 다시 시도하세요.' },
    tabs: { earn: '획득', grow: '성장', wallet: '지갑', profile: '프로필' },
    earn: { title: '코인 획득', all: '전체', none: '지금은 작업이 없습니다.', checkBack: '아래로 당기거나 잠시 후 다시 확인하세요!', left: '남음', min: '분' },
    task: { subscribe: '구독', like: '좋아요', like_comment: '좋아요 + 댓글', subscribe_like: '구독 + 좋아요', watch: '시청' },
    steps: {
      subscribe: '1. YouTube에서 채널 열기<br>2. <b>구독</b> 누르기<br>3. 돌아와서 확인',
      like: '1. YouTube에서 영상 열기<br>2. <b>👍 좋아요</b> 누르기<br>3. 돌아와서 확인',
      like_comment: '1. 영상 열기<br>2. <b>👍 좋아요</b>를 누르고 <b>댓글</b> 남기기 (보너스 코인!)<br>3. 돌아와서 확인',
      subscribe_like: '1. 영상 열기<br>2. 채널을 <b>구독</b>하고 영상에 <b>좋아요</b><br>3. 돌아와서 확인',
      watch: '1. 영상 열기<br>2. 최소 <b>{{min}}분</b> 시청<br>3. 돌아와서 확인',
    },
    modal: { open: '▶ YouTube 열기', verify: '확인하고 받기', verifying: '확인 중…', verifyIn: '확인 ({{s}}초)', openFirst: '먼저 YouTube를 여세요 — 그때 타이머가 시작됩니다.', waitMore: '{{s}}초 더 기다린 후 확인하세요.', done: '완료' },
    grow: { title: '성장', type: '캠페인 유형', videoUrl: '내 영상 URL', minutes: '시청 시간(분, 1–60)', howManySubs: '구독자 몇 명?', howManyCompletions: '완료 몇 건?', price: '≈ 총 {{cost}} 코인 ({{per}}/슬롯 — 수행자는 {{reward}}{{extra}} 획득). 최종 가격은 서버가 확정합니다.', extraMin: ' + 추가 1분당 1', create: '캠페인 만들기', creating: '생성 중…', mine: '내 캠페인', none: '아직 캠페인이 없습니다 — 위에서 만들어 보세요!', done: '완료', pause: '일시정지', resume: '재개', cancel: '취소', errSlots: '원하는 슬롯 수를 입력하세요.', errVideo: 'YouTube 영상 URL을 붙여넣으세요.', errChannel: '계정에 연결된 YouTube 채널이 없습니다. 로그아웃 후 다시 로그인하여 등록하세요.', created: '캠페인을 만들었습니다! {{coins}} 코인 사용.', createdFree: '캠페인을 만들었습니다 (무료 — 소유자).', cancelConfirm: '이 캠페인을 취소할까요? 남은 슬롯은 환불됩니다.' },
    status: { active: '진행 중', paused: '일시정지', completed: '완료', cancelled: '취소됨' },
    wallet: { title: '지갑', none: '아직 거래 내역이 없습니다.' },
    profile: { title: '프로필', coins: '코인', role: '역할', channel: '채널', linked: '연결됨', support: '지원', language: '언어', signOut: '로그아웃', deleteAccount: '계정 삭제', deleteConfirm: '계정과 모든 데이터를 영구히 삭제할까요? 되돌릴 수 없습니다.' },
    tx: { welcome: '🎁 환영 보너스', created: '📣 캠페인 생성 — {{type}}, {{slots}} 슬롯', free: ' (무료)', completed: '✅ 작업 완료 — {{type}}', completedComment: '✅ 작업 + 댓글 보너스 — {{type}}', refund: '↩️ 캠페인 환불', reclaimed: '⚠️ 코인 회수 — {{type}}' },
  },
};

// Translations for the newer screens (Home, channel-add, admin label), merged in
// per language so every page is localized — not just English.
const EXTRA = {
  ar: { tabs: { home: 'الرئيسية' }, profile: { admin: 'لوحة الإدارة' }, grow: { channelLabel: 'القناة المراد تنميتها', addChannel: 'إضافة قناة', adding: 'جارٍ الإضافة…', channelAdded: 'تمت إضافة القناة:', noChannelYet: 'لا توجد قناة بعد — أضف واحدة بالأسفل.' }, home: { balance: 'رصيدك', coinHint: 'أنجز المهام واكسب المزيد من العملات', campaigns: 'الحملات', completed: 'مكتملة', earnCoins: '📋 اكسب عملات', getSubs: '📈 نمِّ', recentActivity: 'النشاط الأخير', noTransactions: 'لا توجد معاملات بعد' } },
  fr: { tabs: { home: 'Accueil' }, profile: { admin: 'Panneau admin' }, grow: { channelLabel: 'Chaîne à développer', addChannel: 'Ajouter une chaîne', adding: 'Ajout…', channelAdded: 'Chaîne ajoutée :', noChannelYet: 'Aucune chaîne — ajoutez-en une ci-dessous.' }, home: { balance: 'Votre solde', coinHint: 'Accomplissez des tâches, gagnez plus de pièces', campaigns: 'Campagnes', completed: 'Terminées', earnCoins: '📋 Gagner des pièces', getSubs: '📈 Booster', recentActivity: 'Activité récente', noTransactions: 'Aucune transaction' } },
  es: { tabs: { home: 'Inicio' }, profile: { admin: 'Panel de administración' }, grow: { channelLabel: 'Canal a hacer crecer', addChannel: 'Añadir canal', adding: 'Añadiendo…', channelAdded: 'Canal añadido:', noChannelYet: 'Aún no hay canal — añade uno abajo.' }, home: { balance: 'Tu saldo', coinHint: 'Completa tareas, gana más monedas', campaigns: 'Campañas', completed: 'Completadas', earnCoins: '📋 Gana monedas', getSubs: '📈 Crecer', recentActivity: 'Actividad reciente', noTransactions: 'Aún no hay transacciones' } },
  pt: { tabs: { home: 'Início' }, profile: { admin: 'Painel de administração' }, grow: { channelLabel: 'Canal para crescer', addChannel: 'Adicionar canal', adding: 'Adicionando…', channelAdded: 'Canal adicionado:', noChannelYet: 'Nenhum canal ainda — adicione um abaixo.' }, home: { balance: 'Seu saldo', coinHint: 'Conclua tarefas, ganhe mais moedas', campaigns: 'Campanhas', completed: 'Concluídas', earnCoins: '📋 Ganhar moedas', getSubs: '📈 Crescer', recentActivity: 'Atividade recente', noTransactions: 'Nenhuma transação ainda' } },
  tr: { tabs: { home: 'Ana sayfa' }, profile: { admin: 'Yönetici paneli' }, grow: { channelLabel: 'Büyütülecek kanal', addChannel: 'Kanal ekle', adding: 'Ekleniyor…', channelAdded: 'Kanal eklendi:', noChannelYet: 'Henüz kanal yok — aşağıdan ekleyin.' }, home: { balance: 'Bakiyeniz', coinHint: 'Görevleri tamamla, daha çok coin kazan', campaigns: 'Kampanyalar', completed: 'Tamamlanan', earnCoins: '📋 Coin kazan', getSubs: '📈 Büyüt', recentActivity: 'Son etkinlik', noTransactions: 'Henüz işlem yok' } },
  id: { tabs: { home: 'Beranda' }, profile: { admin: 'Panel admin' }, grow: { channelLabel: 'Channel untuk ditumbuhkan', addChannel: 'Tambah channel', adding: 'Menambahkan…', channelAdded: 'Channel ditambahkan:', noChannelYet: 'Belum ada channel — tambahkan di bawah.' }, home: { balance: 'Saldo kamu', coinHint: 'Selesaikan tugas, dapat lebih banyak koin', campaigns: 'Kampanye', completed: 'Selesai', earnCoins: '📋 Hasilkan koin', getSubs: '📈 Tumbuh', recentActivity: 'Aktivitas terbaru', noTransactions: 'Belum ada transaksi' } },
  hi: { tabs: { home: 'होम' }, profile: { admin: 'एडमिन पैनल' }, grow: { channelLabel: 'बढ़ाने के लिए चैनल', addChannel: 'चैनल जोड़ें', adding: 'जोड़ रहे हैं…', channelAdded: 'चैनल जोड़ा गया:', noChannelYet: 'अभी कोई चैनल नहीं — नीचे एक जोड़ें।' }, home: { balance: 'आपका बैलेंस', coinHint: 'कार्य पूरे करें, अधिक सिक्के कमाएँ', campaigns: 'अभियान', completed: 'पूर्ण', earnCoins: '📋 सिक्के कमाएँ', getSubs: '📈 बढ़ाएँ', recentActivity: 'हाल की गतिविधि', noTransactions: 'अभी कोई लेन-देन नहीं' } },
  ru: { tabs: { home: 'Главная' }, profile: { admin: 'Панель администратора' }, grow: { channelLabel: 'Канал для роста', addChannel: 'Добавить канал', adding: 'Добавление…', channelAdded: 'Канал добавлен:', noChannelYet: 'Пока нет канала — добавьте ниже.' }, home: { balance: 'Ваш баланс', coinHint: 'Выполняйте задания, зарабатывайте больше монет', campaigns: 'Кампании', completed: 'Выполнено', earnCoins: '📋 Заработать монеты', getSubs: '📈 Рост', recentActivity: 'Недавняя активность', noTransactions: 'Транзакций пока нет' } },
  de: { tabs: { home: 'Start' }, profile: { admin: 'Admin-Bereich' }, grow: { channelLabel: 'Kanal zum Wachsen', addChannel: 'Kanal hinzufügen', adding: 'Wird hinzugefügt…', channelAdded: 'Kanal hinzugefügt:', noChannelYet: 'Noch kein Kanal — füge unten einen hinzu.' }, home: { balance: 'Dein Guthaben', coinHint: 'Aufgaben erledigen, mehr Münzen verdienen', campaigns: 'Kampagnen', completed: 'Abgeschlossen', earnCoins: '📋 Münzen verdienen', getSubs: '📈 Wachsen', recentActivity: 'Letzte Aktivität', noTransactions: 'Noch keine Transaktionen' } },
  'zh-CN': { tabs: { home: '首页' }, profile: { admin: '管理面板' }, grow: { channelLabel: '要增长的频道', addChannel: '添加频道', adding: '添加中…', channelAdded: '已添加频道：', noChannelYet: '还没有频道 — 在下面添加一个。' }, home: { balance: '你的余额', coinHint: '完成任务，赚取更多金币', campaigns: '活动', completed: '已完成', earnCoins: '📋 赚取金币', getSubs: '📈 增长', recentActivity: '最近动态', noTransactions: '暂无交易' } },
  'zh-TW': { tabs: { home: '首頁' }, profile: { admin: '管理面板' }, grow: { channelLabel: '要成長的頻道', addChannel: '新增頻道', adding: '新增中…', channelAdded: '已新增頻道：', noChannelYet: '還沒有頻道 — 在下面新增一個。' }, home: { balance: '你的餘額', coinHint: '完成任務，賺取更多金幣', campaigns: '活動', completed: '已完成', earnCoins: '📋 賺取金幣', getSubs: '📈 成長', recentActivity: '最近動態', noTransactions: '尚無交易' } },
  bn: { tabs: { home: 'হোম' }, profile: { admin: 'অ্যাডমিন প্যানেল' }, grow: { channelLabel: 'বাড়ানোর চ্যানেল', addChannel: 'চ্যানেল যোগ করুন', adding: 'যোগ করা হচ্ছে…', channelAdded: 'চ্যানেল যোগ হয়েছে:', noChannelYet: 'এখনও কোনো চ্যানেল নেই — নিচে একটি যোগ করুন।' }, home: { balance: 'আপনার ব্যালেন্স', coinHint: 'কাজ সম্পন্ন করুন, আরও কয়েন আয় করুন', campaigns: 'ক্যাম্পেইন', completed: 'সম্পন্ন', earnCoins: '📋 কয়েন আয় করুন', getSubs: '📈 বৃদ্ধি', recentActivity: 'সাম্প্রতিক কার্যকলাপ', noTransactions: 'এখনও কোনো লেনদেন নেই' } },
  ja: { tabs: { home: 'ホーム' }, profile: { admin: '管理パネル' }, grow: { channelLabel: '成長させるチャンネル', addChannel: 'チャンネルを追加', adding: '追加中…', channelAdded: 'チャンネルを追加しました:', noChannelYet: 'まだチャンネルがありません — 下から追加してください。' }, home: { balance: '残高', coinHint: 'タスクを完了してコインを稼ごう', campaigns: 'キャンペーン', completed: '完了', earnCoins: '📋 コインを稼ぐ', getSubs: '📈 成長', recentActivity: '最近のアクティビティ', noTransactions: 'まだ取引がありません' } },
  ko: { tabs: { home: '홈' }, profile: { admin: '관리자 패널' }, grow: { channelLabel: '성장시킬 채널', addChannel: '채널 추가', adding: '추가 중…', channelAdded: '채널 추가됨:', noChannelYet: '아직 채널이 없습니다 — 아래에서 추가하세요.' }, home: { balance: '잔액', coinHint: '작업을 완료하고 더 많은 코인을 받으세요', campaigns: '캠페인', completed: '완료', earnCoins: '📋 코인 획득', getSubs: '📈 성장', recentActivity: '최근 활동', noTransactions: '아직 거래 내역이 없습니다' } },
};
for (const lang in EXTRA) {
  if (!T[lang]) continue;
  for (const sec in EXTRA[lang]) T[lang][sec] = Object.assign({}, T[lang][sec], EXTRA[lang][sec]);
}

// Pricing line without the "earner gets ..." detail (not shown to buyers)
const PRICE = {
  en: '≈ {{cost}} coins total ({{per}}/slot). Final price confirmed by server.',
  ar: '≈ {{cost}} عملة إجمالًا ({{per}}/خانة). يؤكّد الخادم السعر النهائي.',
  fr: '≈ {{cost}} pièces au total ({{per}}/place). Prix final confirmé par le serveur.',
  es: '≈ {{cost}} monedas en total ({{per}}/cupo). Precio final confirmado por el servidor.',
  pt: '≈ {{cost}} moedas no total ({{per}}/vaga). Preço final confirmado pelo servidor.',
  tr: '≈ toplam {{cost}} coin ({{per}}/kontenjan). Son fiyatı sunucu onaylar.',
  id: '≈ total {{cost}} koin ({{per}}/slot). Harga akhir dikonfirmasi server.',
  hi: '≈ कुल {{cost}} सिक्के ({{per}}/स्लॉट)। अंतिम मूल्य सर्वर तय करता है।',
  ru: '≈ {{cost}} монет всего ({{per}}/слот). Итоговую цену подтверждает сервер.',
  de: '≈ {{cost}} Münzen gesamt ({{per}}/Platz). Endpreis bestätigt der Server.',
  'zh-CN': '≈ 共 {{cost}} 金币（{{per}}/名额）。最终价格由服务器确认。',
  'zh-TW': '≈ 共 {{cost}} 金幣（{{per}}/名額）。最終價格由伺服器確認。',
  bn: '≈ মোট {{cost}} কয়েন ({{per}}/স্লট)। চূড়ান্ত দাম সার্ভার নিশ্চিত করে।',
  ja: '≈ 合計 {{cost}} コイン（{{per}}/枠）。最終価格はサーバーが確定します。',
  ko: '≈ 총 {{cost}} 코인 ({{per}}/슬롯). 최종 가격은 서버가 확정합니다.',
};
for (const lang in PRICE) { if (T[lang] && T[lang].grow) T[lang].grow.price = PRICE[lang]; }

const STORAGE_KEY = 'subsshare_lang';

function detectLang() {
  const cand = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
  for (const raw of cand) {
    if (!raw) continue;
    const tag = raw; // e.g. "zh-CN", "en-US", "pt-BR"
    if (T[tag]) return tag;                       // exact (zh-CN / zh-TW)
    const base = raw.split('-')[0].toLowerCase(); // e.g. "en", "pt", "zh"
    if (base === 'zh') {
      const region = (raw.split('-')[1] || '').toUpperCase();
      return ['TW', 'HK', 'MO'].includes(region) ? 'zh-TW' : 'zh-CN';
    }
    if (T[base]) return base;
  }
  return 'en';
}

let currentLang = (() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && T[saved] ? saved : detectLang();
})();

function getNested(obj, keys) {
  return keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

// Translate "grow.price" with optional {{var}} interpolation. Falls back to English, then the key.
function t(key, vars) {
  const keys = key.split('.');
  let val = getNested(T[currentLang], keys);
  if (val === undefined) val = getNested(T.en, keys);
  if (val === undefined) return key;
  if (typeof val === 'string' && vars) {
    val = val.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
  }
  return val;
}

function setLang(lang) {
  if (!T[lang]) lang = 'en';
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  applyDir();
}

function getLang() { return currentLang; }

function applyDir() {
  const rtl = !!(LANGS[currentLang] && LANGS[currentLang].rtl);
  document.documentElement.lang = currentLang;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
}

applyDir(); // set <html lang/dir> as early as possible

window.I18N = { t, setLang, getLang, LANGS, isRTL: () => !!(LANGS[currentLang] && LANGS[currentLang].rtl) };
