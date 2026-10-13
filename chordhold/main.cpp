/*
    KOSMIC: a mode chord as a held gesture.
    SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>

    SPDX-License-Identifier: GPL-3.0-only
*/

#include "chordhold.h"

#include <KPluginFactory>

namespace KWin
{

class KWIN_EXPORT ChordHoldFactory : public PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
    Q_INTERFACES(KWin::PluginFactory)

public:
    explicit ChordHoldFactory() = default;

    std::unique_ptr<Plugin> create() const override
    {
        return std::make_unique<ChordHold>();
    }
};

} // namespace KWin

#include "main.moc"
