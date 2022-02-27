define(["map/clientlayer", "map/labelslayer",
        "d3", "leaflet", "moment", "locationmarker", "rbush",
        "leaflet.label", "leaflet.providers", "leaflet-plugins.bing"],
  function (ClientLayer, LabelsLayer, d3, L, moment, LocationMarker, rbush) {
    var options = { worldCopyJump: true,
                    zoomControl: false
                  }

    var AddLayerButton = L.Control.extend({
        options: {
          position: "bottomright"
        },

        initialize: function (f, options) {
          L.Util.setOptions(this, options)
          this.f = f
        },

        onAdd: function () {
          var button = L.DomUtil.create("button", "add-layer")
          button.textContent = ""
          button.setAttribute("data-tooltip", "Füge einen weiteren Kartenanbieter hinzu")

          L.DomEvent.disableClickPropagation(button)
          L.DomEvent.addListener(button, "click", this.f, this)

          this.button = button

          return button
        }
    })

    var LocateButton = L.Control.extend({
        options: {
          position: "bottomright"
        },

        active: false,
        button: undefined,

        initialize: function (f, options) {
          L.Util.setOptions(this, options)
          this.f = f
        },

        onAdd: function () {
          var button = L.DomUtil.create("button", "locate-user")
          button.textContent = ""
          button.setAttribute("data-tooltip", "Zeige meine aktuelle Position auf der Karte")

          L.DomEvent.disableClickPropagation(button)
          L.DomEvent.addListener(button, "click", this.onClick, this)

          this.button = button

          return button
        },

        update: function() {
          this.button.classList.toggle("active", this.active)
        },

        set: function(v) {
          this.active = v
          this.update()
        },

        onClick: function () {
          this.f(!this.active)
        }
    })

    function mkMarker(dict, iconFunc, router) {
      return function (d) {
        var m = L.circleMarker([d.nodeinfo.location.latitude, d.nodeinfo.location.longitude], iconFunc(d))

        m.resetStyle = function () {
          m.setStyle(iconFunc(d))
        }

        m.on("click", router.node(d))
        m.bindLabel(d.nodeinfo.hostname)

        dict[d.nodeinfo.node_id] = m

        return m
      }
    }

    function addLinksToMap(dict, linkScale, graph, router) {
      graph = graph.filter( function (d) {
        return "distance" in d && !d.vpn
      })

      var lines = graph.map( function (d) {
        var opts = { color: linkScale(d.tq).hex(),
                     weight: 4,
                     opacity: 0.5,
                     dashArray: "none"
                   }

        var line = L.polyline(d.latlngs, opts)

        line.resetStyle = function () {
          line.setStyle(opts)
        }

        line.bindLabel(d.source.node.nodeinfo.hostname + " – " + d.target.node.nodeinfo.hostname + "<br><strong>" + showDistance(d) + " / " + showTq(d) + "</strong>")
        line.on("click", router.link(d))

        dict[d.id] = line

        return line
      })

      return lines
    }

    // See http://leafletjs.com/reference.html#path-options
    // Nodes online for more than maxAge days (set in config)
    var iconOnline      = { color: "#fff", fillColor: "#93E929", radius: 6, fillOpacity: 0.5, opacity: 1, weight: 3, className: "stroke-first" }
    var iconOnlineNoVpn = { color: "#93E929", fillColor: "#93E929", radius: 6, fillOpacity: 0.5, opacity: 0.5, weight: 3, className: "stroke-first" }
    // I have no idea what this is fore
    var iconOffline     = { fillColor: "#D43E2A", radius: 4, fillOpacity: 0.25, stroke: false, className: "stroke-first" }
    // More than 3 days offline (hard coded in this file)
    var iconLost        = { fillColor: "#D43E2A", radius: 4, fillOpacity: 0.25, stroke: false, className: "stroke-first" }
    // Less than 3 days offline (hard coded in this file)
    var iconAlert       = { fillColor: "#D43E2A", radius: 4, fillOpacity: 0.5, stroke: false, className: "stroke-first" }
    // First seen within the last maxAge days (set in config)
    var iconNew         = { color: "#fff", fillColor: "#EDFA1F", radius: 6, fillOpacity: 0.5, opacity: 1, weight: 3 }
    var iconNewNoVpn    = { color: "#EDFA1F", fillColor: "#EDFA1F", radius: 6, fillOpacity: 0.5, opacity: 0.5, weight: 3 }

    return function (config, linkScale, sidebar, router, buttons) {
      var self = this
      var barycenter
      var groupOnline, groupOffline, groupNew, groupLost, groupLines
      var savedView

      var map, userLocation
      var layerControl
      var customLayers = new Set()
      var baseLayers = {}

      var locateUserButton = new LocateButton(function (d) {
        if (d)
          enableTracking()
        else
          disableTracking()
      })

      var mybuttons = []

      function addButton(button) {
        var el = button.onAdd()
        mybuttons.push(el)
        buttons.appendChild(el)
      }

      function clearButtons() {
        mybuttons.forEach( function (d) {
          buttons.removeChild(d)
        })
      }

      function saveView() {
        savedView = {center: map.getCenter(),
                     zoom: map.getZoom()}
      }

      function enableTracking() {
        map.locate({watch: true,
                    enableHighAccuracy: true,
                    setView: true
                   })
        locateUserButton.set(true)
      }

      function disableTracking() {
        map.stopLocate()
        locationError()
        locateUserButton.set(false)
      }

      function locationFound(e) {
        if (!userLocation)
          userLocation = new LocationMarker(e.latlng).addTo(map)

        userLocation.setLatLng(e.latlng)
        userLocation.setAccuracy(e.accuracy)
      }

      function locationError() {
        if (userLocation) {
          map.removeLayer(userLocation)
          userLocation = null
        }
      }

      function addLayer(layerName) {
        if (layerName in baseLayers)
          return

        if (customLayers.has(layerName))
          return

        try {
          var layer = L.tileLayer.provider(layerName)
          layerControl.addBaseLayer(layer, layerName)
          customLayers.add(layerName)

          if (localStorageTest())
            localStorage.setItem("map/customLayers", JSON.stringify(Array.from(customLayers)))
        } catch (e) {
          return
        }
      }

      function contextMenuGotoLocation(e) {
        console.log("context menu called at ", e)
        router.gotoLocation(e.latlng)
      }

      function baseLayerChange(e) {
        // Restrict the max zoom to the max zoom of the base layer (otherwise
        // the label and client layers extend the max zoom)
        map.options.maxZoom = e.layer.options.maxZoom

        // Zoom out if the new base map can't handle this zoom level
        if(map.getZoom() > e.layer.options.maxZoom)
          map.setZoom(e.layer.options.maxZoom)
      }

      var el = document.createElement("div")
      el.classList.add("map")

      map = L.map(el, options)

      var layers = config.mapLayers.map( function (d) {
        var layer = {
          "name": d.name
        }

        if("provider" in d)
          if(d.provider === "Bing")
            layer.layer = L.bingLayer(d.config.key, d.config)
          else
            layer.layer = L.tileLayer.provider(d.provider, d.config)
        else if("url" in d)
          layer.layer = L.tileLayer(d.url, d.config)
        else // This should deprecated
          layer.layer = L.tileLayer.provider(d.name, d.config)
        return layer
      })

      layers[0].layer.addTo(map)

      layers.forEach( function (d) {
        baseLayers[d.name] = d.layer
      })

      map.on("locationfound", locationFound)
      map.on("locationerror", locationError)
      map.on("dragend", saveView)
      map.on("contextmenu", contextMenuGotoLocation)
      map.on("baselayerchange", baseLayerChange)

      addButton(locateUserButton)

      addButton(new AddLayerButton(function () {
        /*eslint no-alert:0*/
        var layerName = prompt("Leaflet Provider:")
        addLayer(layerName)
      }))

      layerControl = L.control.layers(baseLayers, [], {position: "bottomright"})
      layerControl.addTo(map)

      if (localStorageTest()) {
        var d = JSON.parse(localStorage.getItem("map/customLayers"))

        if (d)
          d.forEach(addLayer)
      }

      var clientLayer = new ClientLayer()
      clientLayer.options.minZoom = 14
      clientLayer.options.maxZoom = 42
      clientLayer.addTo(map)
      clientLayer.setZIndex(5)

      var labelsLayer = new LabelsLayer()
      labelsLayer.options.maxZoom = 42
      labelsLayer.addTo(map)
      labelsLayer.setZIndex(6)

      var nodeDict = {}
      var linkDict = {}
      var highlight

      function resetMarkerStyles(nodes, links) {
        Object.keys(nodes).forEach( function (d) {
          nodes[d].resetStyle()
        })

        Object.keys(links).forEach( function (d) {
          links[d].resetStyle()
        })
      }

      function setView(bounds) {
        map.fitBounds(bounds, {paddingTopLeft: [sidebar(), 0]})
      }

      function resetZoom() {
        if (barycenter)
          setView(barycenter.getBounds())
      }

      function goto(m) {
        var bounds

        if ("getBounds" in m)
          bounds = m.getBounds()
        else
          bounds = L.latLngBounds([m.getLatLng()])

        setView(bounds)

        return m
      }

      function updateView(nopanzoom) {
        resetMarkerStyles(nodeDict, linkDict)
        var m

        if (highlight !== undefined)
          if (highlight.type === "node") {
            m = nodeDict[highlight.o.nodeinfo.node_id]

            if (m)
              m.setStyle({ color: "orange", weight: 20, fillOpacity: 1, opacity: 0.7, className: "stroke-first" })
          } else if (highlight.type === "link") {
            m = linkDict[highlight.o.id]

            if (m)
              m.setStyle({ weight: 7, opacity: 1, dashArray: "10, 10" })
          }

        if (!nopanzoom)
          if (m)
            goto(m)
          else if (savedView)
            map.setView(savedView.center, savedView.zoom)
          else
            resetZoom()
      }

      function calcBarycenter(nodes) {
        nodes = nodes.map(function (d) { return d.nodeinfo.location })

        if (nodes.length === 0)
          return undefined

        var lats = nodes.map(function (d) { return d.latitude })
        var lngs = nodes.map(function (d) { return d.longitude })

        var barycenter = L.latLng(d3.median(lats), d3.median(lngs))
        var barycenterDev = [d3.deviation(lats), d3.deviation(lngs)]

        if (barycenterDev[0] === undefined)
          barycenterDev[0] = 0

        if (barycenterDev[1] === undefined)
          barycenterDev[1] = 0

        var barycenterCircle = L.latLng(barycenter.lat + barycenterDev[0],
                                        barycenter.lng + barycenterDev[1])

        var r = barycenter.distanceTo(barycenterCircle)

        return L.circle(barycenter, r * config.mapSigmaScale)
      }

      function mapRTree(d) {
        var o = [ d.nodeinfo.location.latitude, d.nodeinfo.location.longitude,
                  d.nodeinfo.location.latitude, d.nodeinfo.location.longitude]

        o.node = d

        return o
      }

      self.setData = function (data) {
        nodeDict = {}
        linkDict = {}

        if (groupOffline)
          groupOffline.clearLayers()

        if (groupOnline)
          groupOnline.clearLayers()

        if (groupNew)
          groupNew.clearLayers()

        if (groupLost)
          groupLost.clearLayers()

        if (groupLines)
          groupLines.clearLayers()

        var lines = addLinksToMap(linkDict, linkScale, data.graph.links, router)
        groupLines = L.featureGroup(lines).addTo(map)

        barycenter = calcBarycenter(data.nodes.all.filter(has_location))

        var nodesOnline = subtract(data.nodes.all.filter(online), data.nodes.new)
        var nodesOffline = subtract(data.nodes.all.filter(offline), data.nodes.lost)

        var markersOnline = nodesOnline.filter(has_location)
          .map(mkMarker(nodeDict, function (d) {
             if (typeof d.vpn === "undefined")
               return iconOnlineNoVpn
             return iconOnline
          }, router))

        var markersOffline = nodesOffline.filter(has_location)
          .map(mkMarker(nodeDict, function () { return iconOffline }, router))

        var markersNew = data.nodes.new.filter(has_location)
          .map(mkMarker(nodeDict, function (d) {
             if (typeof d.vpn === "undefined")
               return iconNewNoVpn
             return iconNew
           }, router))

        var markersLost = data.nodes.lost.filter(has_location)
          .map(mkMarker(nodeDict, function (d) {
            if (d.lastseen.isAfter(moment(data.now).subtract(3, "days")))
              return iconAlert

            return iconLost
          }, router))

        groupOffline = L.featureGroup(markersOffline).addTo(map)
        groupOnline = L.featureGroup(markersOnline).addTo(map)
        groupLost = L.featureGroup(markersLost).addTo(map)
        groupNew = L.featureGroup(markersNew).addTo(map)

        var rtreeOnlineAll = rbush(9)

        rtreeOnlineAll.load(data.nodes.all.filter(online).filter(has_location).map(mapRTree))

        clientLayer.setData(rtreeOnlineAll)
        labelsLayer.setData({online: nodesOnline.filter(has_location),
                             offline: nodesOffline.filter(has_location),
                             new: data.nodes.new.filter(has_location),
                             lost: data.nodes.lost.filter(has_location)
                            })

        updateView(true)
      }

      self.resetView = function () {
        disableTracking()
        highlight = undefined
        updateView()
      }

      self.gotoNode = function (d) {
        disableTracking()
        highlight = {type: "node", o: d}
        updateView()
      }

      self.gotoLink = function (d) {
        disableTracking()
        highlight = {type: "link", o: d}
        updateView()
      }

      self.gotoLocation = function () {
        //ignore
      }

      self.destroy = function () {
        clearButtons()
        map.remove()

        if (el.parentNode)
          el.parentNode.removeChild(el)
      }

      self.render = function (d) {
        d.appendChild(el)
        map.invalidateSize()
      }

      return self
    }
})
