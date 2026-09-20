'use strict';
// lib/async-errors.js — שגיאה בתוך route אסינכרוני
//
// Express 4 לא תופס הבטחה שנדחתה בתוך handler מסוג async. השגיאה הייתה הופכת ל-unhandled
// rejection, ו-Node מפיל את התהליך: בקשה אחת שגויה מפילה את השרת לכל המשתמשים. כאן ההבטחה
// הנדחית מועברת ל-next(err), כלומר למטפל השגיאות הרגיל, והשרת ממשיך.
// זו אותה תיקון שחבילת express-async-errors עושה; כתוב כאן כדי לא להוסיף תלות.
let Layer;
try {
  Layer = require('express/lib/router/layer');
} catch (_) {
  // Express 5 מטפל בהבטחות בעצמו — אין מה לתקן
}

if (Layer && !Layer.prototype.__asyncErrorsPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();   // middleware של שגיאות
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncErrorsPatched = true;
}
