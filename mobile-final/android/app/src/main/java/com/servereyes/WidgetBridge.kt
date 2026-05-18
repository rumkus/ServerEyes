package com.servereyes

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class WidgetBridge(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WidgetBridge"

    @ReactMethod
    fun setToken(token: String) {
        val prefs = reactApplicationContext.getSharedPreferences("ServerEyesWidgetPrefs", Context.MODE_PRIVATE)
        prefs.edit().putString("servereyes_token", token).apply()
        refreshWidget()
    }

    @ReactMethod
    fun clearToken() {
        val prefs = reactApplicationContext.getSharedPreferences("ServerEyesWidgetPrefs", Context.MODE_PRIVATE)
        prefs.edit().remove("servereyes_token").apply()
        refreshWidget()
    }

    @ReactMethod
    fun refreshWidget() {
        val intent = Intent("com.servereyes.WIDGET_REFRESH")
        intent.component = ComponentName(reactApplicationContext, ServerEyesWidget::class.java)
        reactApplicationContext.sendBroadcast(intent)
    }
}
