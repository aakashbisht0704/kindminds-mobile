package org.kindminds.kit

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.UUID

/**
 * Android peripheral role for the mesh.
 *
 * react-native-ble-plx only provides the central (scanner/client) role. This
 * module adds the missing half: a connectable GATT server with the same service
 * and frame characteristic the central path already uses, plus a BLE
 * advertisement so nearby phones can discover us without a pre-existing link.
 *
 * Two details decide whether the link actually carries bytes:
 *  - every characteristic that can notify needs a Client Characteristic
 *    Configuration descriptor, or a client can never subscribe to it;
 *  - `startAdvertising` reports success from `onStartSuccess`, never from the
 *    call itself, because Android fails asynchronously (too many advertisers,
 *    data too large). Reporting "ready" while nothing is on air is what makes a
 *    broken radio look healthy.
 *
 * Frames received over GATT are emitted to JS as base64 through
 * `ReactContext.emitDeviceEvent`, which works under both the bridge and
 * bridgeless mode. The JS transport feeds them into the same MeshEngine used by
 * the central path.
 */
class MeshPeripheralModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var gattServer: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var serviceUuid: UUID? = null
  private var frameUuid: UUID? = null
  private var frameCharacteristic: BluetoothGattCharacteristic? = null
  private val clients = mutableSetOf<String>()
  /** Addresses that wrote the notification descriptor; the only ones we may notify. */
  private val subscribers = mutableSetOf<String>()
  private var advertising = false
  private var advertisingCallback: AdvertiseCallback? = null

  override fun getName(): String = "MeshPeripheral"

  private fun hasPermission(permission: String): Boolean {
    return ContextCompat.checkSelfPermission(reactContext, permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun requireBluetoothPermissions(promise: Promise): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (!hasPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) ||
        !hasPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
      ) {
        promise.reject("permission", "Bluetooth advertise/connect permission is missing.")
        return false
      }
    }
    return true
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun startAdvertising(serviceUuid: String, localName: String, promise: Promise) {
    if (!requireBluetoothPermissions(promise)) return
    if (advertising && gattServer != null) {
      promise.resolve(true)
      return
    }

    val service: UUID
    val frame: UUID
    try {
      service = UUID.fromString(serviceUuid)
      frame = UUID.fromString("7f3a6b11-9c4d-4e21-8f77-2a5b9e0c1d34")
    } catch (error: Exception) {
      promise.reject("bad_uuid", error.message)
      return
    }

    val manager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter: BluetoothAdapter? = manager?.adapter
    if (manager == null || adapter == null) {
      promise.reject("unsupported", "This device has no Bluetooth adapter.")
      return
    }
    if (!adapter.isEnabled) {
      promise.reject("off", "Bluetooth is off.")
      return
    }
    if (!adapter.isMultipleAdvertisementSupported) {
      promise.reject("unsupported", "This device cannot advertise Bluetooth LE.")
      return
    }

    this.serviceUuid = service
    this.frameUuid = frame

    var settled = false
    var serviceAdded = false
    var advertStarted = false
    val handler = Handler(Looper.getMainLooper())

    fun fail(code: String, message: String) {
      if (settled) return
      settled = true
      handler.removeCallbacksAndMessages(null)
      stopInternal()
      promise.reject(code, message)
    }

    fun settleIfReady() {
      if (settled || !serviceAdded || !advertStarted) return
      settled = true
      handler.removeCallbacksAndMessages(null)
      advertising = true
      promise.resolve(true)
    }

    try {
      startGattServer(manager, service, frame) { serviceAdded = true; settleIfReady() }
      startAdvertiser(
        adapter,
        service,
        localName,
        onStarted = {
          advertStarted = true
          advertising = true
          settleIfReady()
        },
        onFailed = { code -> fail("advertise_failed", "Android refused to advertise (error $code).") },
      )
      // Neither callback is guaranteed on a hostile stack; do not hang forever.
      handler.postDelayed({
        if (settled) return@postDelayed
        // Advertising on air is the part that matters; a stack that never
        // reports the service is added must not make a working radio look dead.
        if (advertStarted) {
          settled = true
          promise.resolve(true)
        } else {
          fail("timeout", "Bluetooth advertising did not start in time.")
        }
      }, 6_000)
    } catch (error: Exception) {
      Log.w("MeshPeripheral", "startAdvertising failed", error)
      fail("error", error.message ?: "Could not start BLE peripheral.")
    }
  }

  @SuppressLint("MissingPermission")
  private fun startGattServer(
    manager: BluetoothManager,
    serviceUuid: UUID,
    frameUuid: UUID,
    onServiceAdded: () -> Unit,
  ) {
    gattServer?.close()
    clients.clear()
    subscribers.clear()

    val callback = object : BluetoothGattServerCallback() {
      override fun onServiceAdded(status: Int, service: BluetoothGattService?) {
        if (status == BluetoothGatt.GATT_SUCCESS) onServiceAdded()
        else Log.w("MeshPeripheral", "addService failed with status $status")
      }

      override fun onCharacteristicWriteRequest(
        device: BluetoothDevice?,
        requestId: Int,
        characteristic: BluetoothGattCharacteristic?,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray?,
      ) {
        if (characteristic?.uuid == frameUuid && value != null && value.isNotEmpty()) {
          emitFrame(value)
        }
        if (responseNeeded && device != null) {
          try {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
          } catch (error: Exception) {
            Log.w("MeshPeripheral", "sendResponse failed", error)
          }
        }
      }

      override fun onDescriptorWriteRequest(
        device: BluetoothDevice?,
        requestId: Int,
        descriptor: BluetoothGattDescriptor?,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray?,
      ) {
        val address = device?.address
        if (address != null && descriptor?.uuid == CLIENT_CHARACTERISTIC_CONFIG) {
          val enabled = value != null && value.isNotEmpty() &&
            (value[0].toInt() and 0x01) != 0
          if (enabled) subscribers.add(address) else subscribers.remove(address)
        }
        if (responseNeeded && device != null) {
          try {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
          } catch (error: Exception) {
            Log.w("MeshPeripheral", "sendResponse failed", error)
          }
        }
      }

      override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
        val connected = newState == BluetoothGatt.STATE_CONNECTED
        val address = device?.address
        if (address != null) {
          if (connected) clients.add(address) else {
            clients.remove(address)
            subscribers.remove(address)
          }
        }
        val payload = Arguments.createMap().apply {
          putString("deviceId", address ?: "")
          putBoolean("connected", connected)
        }
        reactContext.emitDeviceEvent("MeshPeripheralPeer", payload)
      }
    }

    val server = manager.openGattServer(reactContext, callback)
      ?: throw IllegalStateException("Could not open a GATT server.")
    val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val characteristic = BluetoothGattCharacteristic(
      frameUuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE or
        BluetoothGattCharacteristic.PERMISSION_READ,
    )
    // Without this descriptor a client cannot enable notifications, so the
    // server-to-client half of every link stays silent.
    characteristic.addDescriptor(
      BluetoothGattDescriptor(
        CLIENT_CHARACTERISTIC_CONFIG,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    service.addCharacteristic(characteristic)
    if (!server.addService(service)) {
      server.close()
      throw IllegalStateException("Could not register the mesh GATT service.")
    }
    gattServer = server
    frameCharacteristic = characteristic
  }

  @SuppressLint("MissingPermission")
  private fun startAdvertiser(
    adapter: BluetoothAdapter,
    serviceUuid: UUID,
    localName: String,
    onStarted: () -> Unit,
    onFailed: (Int) -> Unit,
  ) {
    val leAdvertiser = adapter.bluetoothLeAdvertiser
      ?: throw IllegalStateException("Bluetooth LE advertiser is unavailable.")
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(serviceUuid))
      .setIncludeDeviceName(false)
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        Log.i("MeshPeripheral", "advertising $localName")
        onStarted()
      }

      override fun onStartFailure(errorCode: Int) {
        Log.w("MeshPeripheral", "advertise failed: $errorCode")
        advertising = false
        onFailed(errorCode)
      }
    }
    advertisingCallback = callback
    leAdvertiser.startAdvertising(settings, data, callback)
    advertiser = leAdvertiser
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun notifyFrame(base64: String, promise: Promise) {
    val server = gattServer
    val characteristic = frameCharacteristic
    if (server == null || characteristic == null) {
      promise.resolve(0)
      return
    }
    val value = try {
      Base64.decode(base64, Base64.NO_WRAP)
    } catch (error: Exception) {
      promise.reject("bad_frame", error.message)
      return
    }

    // Prefer clients that actually subscribed; fall back to every client when a
    // stack never delivered the descriptor write.
    val targets = if (subscribers.isNotEmpty()) subscribers.toList() else clients.toList()
    var sent = 0
    for (address in targets) {
      try {
        val device = server.connectedDevices.firstOrNull { it.address == address } ?: continue
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          if (server.notifyCharacteristicChanged(device, characteristic, false, value) ==
            BluetoothStatusCodes.SUCCESS
          ) {
            sent += 1
          }
        } else {
          @Suppress("DEPRECATION")
          characteristic.value = value
          @Suppress("DEPRECATION")
          if (server.notifyCharacteristicChanged(device, characteristic, false)) sent += 1
        }
      } catch (error: Exception) {
        Log.w("MeshPeripheral", "notify failed for $address", error)
      }
    }
    promise.resolve(sent)
  }

  private fun emitFrame(value: ByteArray) {
    reactContext.emitDeviceEvent("MeshPeripheralFrame", Base64.encodeToString(value, Base64.NO_WRAP))
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun stopAdvertising(promise: Promise) {
    stopInternal()
    promise.resolve(true)
  }

  @SuppressLint("MissingPermission")
  private fun stopInternal() {
    try {
      advertisingCallback?.let { advertiser?.stopAdvertising(it) }
    } catch (_: Exception) {
    }
    try {
      gattServer?.close()
    } catch (_: Exception) {
    }
    advertisingCallback = null
    advertiser = null
    gattServer = null
    frameCharacteristic = null
    clients.clear()
    subscribers.clear()
    advertising = false
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter on the JS side.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by NativeEventEmitter on the JS side.
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }

  private companion object {
    val CLIENT_CHARACTERISTIC_CONFIG: UUID =
      UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }
}
