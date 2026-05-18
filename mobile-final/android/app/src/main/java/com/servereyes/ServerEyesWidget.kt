package com.servereyes

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Handler
import android.os.Looper
import android.widget.RemoteViews
import org.json.JSONArray
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class ServerEyesWidget : AppWidgetProvider() {

    companion object {
        private const val API_URL = "https://servereyes-production.up.railway.app"
        private const val ACTION_REFRESH = "com.servereyes.WIDGET_REFRESH"
        private const val PREFS_NAME = "ServerEyesWidgetPrefs"
        private const val KEY_TOKEN = "servereyes_token"
        // Max machines to show in widget
        private const val MAX_MACHINES = 8
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, ServerEyesWidget::class.java))
            for (id in ids) {
                updateWidget(context, appWidgetManager, id)
            }
        }
    }

    private fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
        val views = RemoteViews(context.packageName, R.layout.widget_servereyes)

        // Click on widget opens app
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launchIntent != null) {
            val pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
        }

        views.setTextViewText(R.id.widget_updated, "Cargando...")
        appWidgetManager.updateAppWidget(appWidgetId, views)

        // Fetch data in background
        thread {
            try {
                val token = getToken(context)
                if (token.isNullOrEmpty()) {
                    Handler(Looper.getMainLooper()).post {
                        views.setTextViewText(R.id.widget_updated, "Inicia sesion en la app")
                        views.setTextViewText(R.id.widget_online, "-")
                        views.setTextViewText(R.id.widget_offline, "-")
                        views.removeAllViews(R.id.widget_machines_list)
                        appWidgetManager.updateAppWidget(appWidgetId, views)
                    }
                    return@thread
                }

                val url = URL("$API_URL/api/machines")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Content-Type", "application/json")
                conn.connectTimeout = 10000
                conn.readTimeout = 10000

                val responseCode = conn.responseCode
                if (responseCode == 200) {
                    val reader = BufferedReader(InputStreamReader(conn.inputStream))
                    val response = reader.readText()
                    reader.close()

                    val machines = JSONArray(response)
                    var online = 0
                    var offline = 0

                    for (i in 0 until machines.length()) {
                        val m = machines.getJSONObject(i)
                        if (m.optBoolean("is_online", false)) online++ else offline++
                    }

                    Handler(Looper.getMainLooper()).post {
                        views.setTextViewText(R.id.widget_online, online.toString())
                        views.setTextViewText(R.id.widget_offline, offline.toString())

                        val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
                        views.setTextViewText(R.id.widget_updated, timeFormat.format(Date()))

                        // Machine list
                        views.removeAllViews(R.id.widget_machines_list)
                        val count = minOf(machines.length(), MAX_MACHINES)
                        for (i in 0 until count) {
                            val m = machines.getJSONObject(i)
                            val row = RemoteViews(context.packageName, R.layout.widget_machine_row)
                            val name = m.optString("machine_name", "???")
                            val isOn = m.optBoolean("is_online", false)

                            row.setTextViewText(R.id.row_name, name)
                            row.setTextViewText(R.id.row_status, if (isOn) "ON" else "OFF")
                            row.setTextColor(R.id.row_status, if (isOn) 0xFF00E676.toInt() else 0xFFFF5252.toInt())
                            row.setInt(R.id.row_dot, "setBackgroundResource", if (isOn) R.drawable.dot_online else R.drawable.dot_offline)

                            views.addView(R.id.widget_machines_list, row)
                        }
                        if (machines.length() > MAX_MACHINES) {
                            val moreRow = RemoteViews(context.packageName, R.layout.widget_machine_row)
                            moreRow.setTextViewText(R.id.row_name, "+" + (machines.length() - MAX_MACHINES) + " mas...")
                            moreRow.setTextColor(R.id.row_name, 0xFF888888.toInt())
                            views.addView(R.id.widget_machines_list, moreRow)
                        }

                        appWidgetManager.updateAppWidget(appWidgetId, views)
                    }
                } else {
                    Handler(Looper.getMainLooper()).post {
                        views.setTextViewText(R.id.widget_updated, "Error $responseCode")
                        appWidgetManager.updateAppWidget(appWidgetId, views)
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                Handler(Looper.getMainLooper()).post {
                    views.setTextViewText(R.id.widget_updated, "Sin conexion")
                    appWidgetManager.updateAppWidget(appWidgetId, views)
                }
            }
        }
    }

    private fun getToken(context: Context): String? {
        // Try widget's own SharedPreferences first (written by the app)
        try {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val token = prefs.getString(KEY_TOKEN, null)
            if (!token.isNullOrEmpty()) return token
        } catch (_: Exception) {}

        // Try reading from AsyncStorage SQLite database (RKStorage)
        try {
            val dbPath = File(context.filesDir.parentFile, "databases/RKStorage")
            if (dbPath.exists()) {
                val db = SQLiteDatabase.openDatabase(dbPath.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
                val cursor = db.rawQuery("SELECT value FROM catalystLocalStorage WHERE key = ?", arrayOf("servereyes_token"))
                if (cursor.moveToFirst()) {
                    val token = cursor.getString(0)
                    cursor.close()
                    db.close()
                    // Cache in SharedPreferences for next time
                    if (!token.isNullOrEmpty()) {
                        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
                    }
                    return token
                }
                cursor.close()
                db.close()
            }
        } catch (_: Exception) {}

        return null
    }
}
